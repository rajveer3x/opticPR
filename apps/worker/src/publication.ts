import { reportSchema, type Report } from '@opticpr/contracts';
import { Prisma, type PrismaClient } from '@opticpr/database';
import { githubPublicationClientsFromEnv, type GitHubPublicationClientFactory } from '@opticpr/repository';
import { AccessRevokedError, logger, repositoryScope } from '@opticpr/runtime';
import { lockPullRequest, observeLiveTarget, publicationIntent, publicationKey, pullKey, reviewTransactionOptions } from './current-review.js';

export function summaryMarker(repositoryId: string, number: number) {
  return `<!-- opticpr:summary:${repositoryId}:${number} -->`;
}

export function summaryBody(repositoryId: string, number: number, baseSha: string, headSha: string, report?: Report) {
  const lines = [summaryMarker(repositoryId, number), '## OpticPR review', '', `Head: \`${headSha}\``, `Base: \`${baseSha}\``, ''];
  if (!report) lines.push('Review pending for this revision. The previous review does not cover this comparison.');
  else {
    lines.push(`Reviewed SHA: \`${report.input.headSha}\``, `Run: \`${report.runId}\``, '',
      `Coverage: **${report.coverage.status}** (${report.coverage.scope}).`,
      `Analyzed ${report.coverage.analyzedFiles.length} of ${report.coverage.changedFiles.length} changed files.`, '');
    if (report.coverage.status === 'unknown') lines.push('Analysis is incomplete. An empty finding list does not indicate a clean review.', '');
    lines.push(`Findings: ${report.findings.length}.`);
    for (const finding of report.findings.slice(0, 20)) lines.push(`- ${escapeText(finding.title)} (${finding.severity})`);
  }
  return lines.join('\n');
}
function escapeText(text: string) { return text.slice(0, 300).replace(/[\\`*_{}[\]()<>#@!|]/g, char => `\\${char}`).replace(/[\r\n]/g, ' '); }

/** Honor server delays as a minimum, adding jitter without sleeping in the worker. */
export function publicationFailure(error: unknown, attempt: number, now = Date.now(), random = Math.random) {
  const failure = error as { status?: unknown; response?: { headers?: Record<string, string | undefined> } } | null;
  const status = typeof failure?.status === 'number' ? failure.status : null;
  const headers = failure?.response?.headers ?? {};
  const retryAfter = headers['retry-after'];
  const seconds = Number(retryAfter);
  const retryAfterMs = retryAfter === undefined ? 0 : Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retryAfter) - now) || 0;
  const reset = headers['x-ratelimit-remaining'] === '0' ? Math.max(0, Number(headers['x-ratelimit-reset']) * 1000 - now) || 0 : 0;
  const delay = Math.max(1000 * 2 ** Math.max(0, attempt - 1), retryAfterMs, reset, status === 403 || status === 429 ? 60000 : 0) + Math.floor(random() * 1000);
  const nextAttemptAt = new Date(now + delay);
  return { nextAttemptAt, diagnostics: { status, attempt, retryAt: nextAttemptAt.toISOString(),
    code: status === 403 || status === 429 ? 'github_rate_or_permission_limit' : 'github_publication_failed' } };
}

export function createPublisher(db: PrismaClient, clients: GitHubPublicationClientFactory = githubPublicationClientsFromEnv()) {
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const entries = await db.reviewPublication.findMany({ where: { state: 'pending', attempts: { lt: 3 }, nextAttemptAt: { lte: new Date() } }, orderBy: { nextAttemptAt: 'asc' }, take: 50, include: { run: true } });
      for (const entry of entries) {
        try {
          const scope = await repositoryScope(db, entry.run.installationId!, entry.repositoryId, entry.run.grantVersion!);
          await db.$transaction(async tx => {
            await lockPullRequest(tx, scope, entry.pullRequestNumber);
            const where = publicationKey(entry.repositoryId, entry.pullRequestNumber);
            const current = await tx.reviewPublication.findUniqueOrThrow({ where });
            if (current.state !== 'pending' || current.runId !== entry.runId || current.attempts >= 3 || current.nextAttemptAt > new Date()) return;
            const assertAccess = async () => { await repositoryScope(tx, scope.installationId, scope.repositoryId, scope.grantVersion); };
            let attemptedRunId = current.runId;
            let attempt = current.attempts + 1;
            try {
              const client = clients(scope, assertAccess);
              // Recover even when create succeeded but its response/transaction was lost.
              // A user copying our marker cannot impersonate the owning GitHub App.
              const marker = summaryMarker(entry.repositoryId, entry.pullRequestNumber);
              const comments = await client.comments(entry.pullRequestNumber);
              const pr = await tx.pullRequest.findUniqueOrThrow({ where: pullKey(entry.repositoryId, entry.pullRequestNumber) });
              const owned = comments.filter(comment => comment.appOwned);
              let commentId = owned.find(comment => comment.id === pr.commentId)?.id ?? owned.find(comment => comment.body.split('\n')[0] === marker)?.id;
              if (commentId) await tx.pullRequest.update({ where: pullKey(entry.repositoryId, entry.pullRequestNumber), data: { commentId } });
              // Bound reconciliation when an author pushes continuously. The durable
              // pending intent resumes next tick if the target keeps moving.
              for (let revision = 0; revision < 3; revision++) {
                // This live read and the locked desired-key comparison immediately
                // precede every create/update, including a reconciliation write.
                const target = await observeLiveTarget(tx, scope, entry.pullRequestNumber, client);
                if (!target) return;
                await publicationIntent(tx, entry.repositoryId, entry.pullRequestNumber, target.run.id);
                const intent = await tx.reviewPublication.findUniqueOrThrow({ where });
                if (intent.state === 'failed' || intent.attempts >= 3 || intent.nextAttemptAt > new Date()) return;
                attemptedRunId = intent.runId;
                attempt = intent.attempts + 1;
                const ready = target.run.state === 'completed' && target.run.report !== null && target.pr.latestRunId === target.run.id &&
                  target.pr.desiredRunKey === target.run.logicalKey && target.pr.baseSha === target.run.baseSha && target.pr.headSha === target.run.headSha;
                if (!ready && !commentId) {
                  await tx.reviewPublication.update({ where, data: { state: 'waiting', error: null } });
                  return;
                }
                const report = ready ? reportSchema.parse(target.run.report) : undefined;
                const body = summaryBody(entry.repositoryId, entry.pullRequestNumber, target.run.baseSha, target.run.headSha, report);
                if (commentId) await client.updateComment(commentId, body);
                else commentId = await client.createComment(entry.pullRequestNumber, body);
                await tx.pullRequest.update({ where: pullKey(entry.repositoryId, entry.pullRequestNumber), data: { commentId, publishedRunId: ready ? target.run.id : null } });
                const after = await observeLiveTarget(tx, scope, entry.pullRequestNumber, client);
                if (!after) return;
                if (after.pr.desiredRunKey === target.run.logicalKey && after.pr.baseSha === target.run.baseSha && after.pr.headSha === target.run.headSha) {
                  await tx.reviewPublication.update({ where, data: { state: ready ? 'published' : 'waiting', attempts: attempt, error: null, diagnostics: Prisma.DbNull } });
                  return;
                }
              }
              throw new Error('PR revisions kept changing during publication');
            } catch (error) {
              const revoked = error instanceof AccessRevokedError;
              const failure = publicationFailure(error, attempt);
              // Fence failures against the intended revision: observing a newer pair
              // must not exhaust that revision's budget with an older request's error.
              await tx.reviewPublication.updateMany({ where: { repositoryId: entry.repositoryId, pullRequestNumber: entry.pullRequestNumber, runId: attemptedRunId }, data: {
                state: revoked ? 'cancelled' : attempt >= 3 ? 'failed' : 'pending', attempts: attempt,
                error: revoked ? 'Repository access revoked' : 'GitHub publication failed; retry with publication:retry after recovery', ...failure,
              } });
            }
          }, reviewTransactionOptions);
        } catch (error) {
          if (error instanceof AccessRevokedError) {
            await db.reviewPublication.updateMany({ where: {
              repositoryId: entry.repositoryId, pullRequestNumber: entry.pullRequestNumber, runId: entry.runId, state: 'pending',
              run: { installationId: entry.run.installationId, grantVersion: entry.run.grantVersion },
            }, data: { state: 'cancelled', error: 'Repository access revoked' } });
          } else logger.warn({ runId: entry.runId }, 'Publication deferred; database transaction unavailable');
        }
      }
    } finally { ticking = false; }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();
  let stopped = false;
  function start(intervalMs = 1000) {
    const poll = () => {
      current = tick().catch(() => logger.warn('Publication reconciliation deferred; dependency unavailable')).finally(() => {
        if (!stopped) timer = setTimeout(poll, intervalMs);
      });
    };
    poll();
  }
  return { tick, start, async close() { stopped = true; clearTimeout(timer); await current; } };
}

/** Operator-only retry until authenticated maintainer actions exist in slice 07. */
export async function retryPublication(db: PrismaClient, repositoryId: string, number: number) {
  const entry = await db.reviewPublication.findUniqueOrThrow({ where: publicationKey(repositoryId, number), include: { run: true } });
  const scope = await repositoryScope(db, entry.run.installationId!, repositoryId, entry.run.grantVersion!);
  return db.$transaction(async tx => {
    await lockPullRequest(tx, scope, number);
    return tx.reviewPublication.update({ where: publicationKey(repositoryId, number), data: { state: 'pending', attempts: 0, nextAttemptAt: new Date(), error: null } });
  }, reviewTransactionOptions);
}
