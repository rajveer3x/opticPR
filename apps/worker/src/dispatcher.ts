import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@opticpr/database';
import { IneligiblePullRequestError, githubClientsFromEnv, type GitHubClientFactory } from '@opticpr/repository';
import { AccessRevokedError, enqueueRun, logger, repositoryScope, type Queue } from '@opticpr/runtime';
import { lockPullRequest, observeLiveTarget, reviewTransactionOptions } from './current-review.js';

export function createDispatcher(db: PrismaClient, queue: Queue, clients: GitHubClientFactory = githubClientsFromEnv()) {
  let ticking = false;
  let outstandingCursor: string | undefined;
  let cancelledCursor: string | undefined;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = new Date();
      const pending = await db.intakeOutbox.findMany({ where: {
        state: 'pending', nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      }, orderBy: { createdAt: 'asc' }, take: 50 });
      for (const entry of pending) {
        const leaseToken = randomUUID();
        const claimed = await db.intakeOutbox.updateMany({ where: {
          id: entry.id, state: 'pending', OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
        }, data: { leaseToken, leaseUntil: new Date(Date.now() + 60000), attempts: { increment: 1 } } });
        if (!claimed.count) continue;
        const owned = { id: entry.id, state: 'pending', leaseToken };
        try {
          const scope = await repositoryScope(db, entry.installationId, entry.repositoryId, entry.grantVersion);
          let run = entry.runId ? await db.reviewRun.findUniqueOrThrow({ where: { id: entry.runId } }) : null;
          if (!run) {
            const assertAccess = async () => { await repositoryScope(db, scope.installationId, scope.repositoryId, scope.grantVersion); };
            const client = clients(scope, assertAccess);
            run = await db.$transaction(async tx => {
              await lockPullRequest(tx, scope, entry.pullRequestNumber);
              const stillOwned = await tx.intakeOutbox.findFirst({ where: owned });
              if (!stillOwned) throw new AccessRevokedError();
              const target = await observeLiveTarget(tx, scope, entry.pullRequestNumber, client);
              if (!target) throw new IneligiblePullRequestError();
              const stored = target.run;
              await tx.intakeOutbox.update({ where: { id: entry.id }, data: { runId: stored.id } });
              return stored;
            }, reviewTransactionOptions);
          }
          if (run.state === 'queued' || run.state === 'running') await enqueueRun(queue, run);
          await db.intakeOutbox.updateMany({ where: owned, data: { state: 'dispatched', leaseToken: null, leaseUntil: null, error: null } });
        } catch (error) {
          const cancelled = error instanceof AccessRevokedError || error instanceof IneligiblePullRequestError;
          await db.intakeOutbox.updateMany({ where: owned, data: {
            state: cancelled ? 'cancelled' : 'pending', leaseToken: null, leaseUntil: null,
            nextAttemptAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(entry.attempts, 6))),
            error: cancelled ? 'Repository unavailable or PR ineligible' : 'Dispatch failed; will retry',
          } });
          if (!cancelled) logger.warn({ outboxId: entry.id }, 'GitHub dispatch deferred');
        }
      }
      // PostgreSQL remains authoritative after Redis loses even acknowledged jobs.
      const outstanding = await db.reviewRun.findMany({ where: { source: 'github', state: { in: ['queued', 'running'] }, ...(outstandingCursor ? { id: { gt: outstandingCursor } } : {}) }, orderBy: { id: 'asc' }, take: 100 });
      // Rotate bounded batches so existing jobs cannot starve later missing jobs.
      outstandingCursor = outstanding.length === 100 ? outstanding.at(-1)!.id : undefined;
      for (const run of outstanding) {
        try {
          await repositoryScope(db, run.installationId!, run.repositoryId, run.grantVersion!);
          if (!await queue.getJob(run.logicalKey)) await enqueueRun(queue, run);
        } catch (error) {
          if (!(error instanceof AccessRevokedError)) throw error;
          await db.reviewRun.updateMany({ where: { id: run.id, state: { in: ['queued', 'running'] } }, data: { state: 'cancelled', error: 'Repository access revoked' } });
        }
      }
      const cancelled = await db.reviewRun.findMany({ where: { source: 'github', state: 'cancelled', ...(cancelledCursor ? { id: { gt: cancelledCursor } } : {}) }, orderBy: { id: 'asc' }, take: 100 });
      cancelledCursor = cancelled.length === 100 ? cancelled.at(-1)!.id : undefined;
      for (const run of cancelled) {
        const job = await queue.getJob(run.logicalKey);
        if (job && await job.getState() !== 'active') await job.remove();
      }
    } finally { ticking = false; }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();
  let stopped = false;
  function start(intervalMs = 1000) {
    const poll = () => {
      current = tick().catch(() => logger.warn('Intake reconciliation deferred; dependency unavailable')).finally(() => {
        if (!stopped) timer = setTimeout(poll, intervalMs);
      });
    };
    poll();
  }
  return { tick, start, async close() { stopped = true; clearTimeout(timer); await current; } };
}
