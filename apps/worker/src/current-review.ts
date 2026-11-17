import { githubConfig, inputSchema, reportSchema, type GitHubScope, type Report } from '@opticpr/contracts';
import { Prisma, type PrismaClient } from '@opticpr/database';
import type { GitHubRepositoryClient } from '@opticpr/repository';
import { lockInstallation, repositoryScope, runIdentity } from '@opticpr/runtime';
import { snapshotFindingHistory } from './finding-history.js';
import { inlineIntents } from './inline-comments.js';

type Tx = Prisma.TransactionClient;
export const reviewTransactionOptions = { maxWait: 15000, timeout: 120000 };
export const pullKey = (repositoryId: string, number: number) => ({ repositoryId_number: { repositoryId, number } });
export const publicationKey = (repositoryId: string, number: number) => ({ repositoryId_pullRequestNumber: { repositoryId, pullRequestNumber: number } });

/** Always take the installation lock first, then this PR lock, including remote writes.
 * PostgreSQL releases both on a process/connection failure; there is no expiring lease
 * that could let a second publisher write while the first is still in flight. */
export async function lockPullRequest(tx: Tx, scope: GitHubScope, number: number) {
  await lockInstallation(tx, scope.installationId);
  await repositoryScope(tx, scope.installationId, scope.repositoryId, scope.grantVersion);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pr:${scope.repositoryId}:${number}`}, 0))::text`;
}

export async function publicationIntent(tx: Tx, repositoryId: string, number: number, runId: string) {
  const where = publicationKey(repositoryId, number);
  const existing = await tx.reviewPublication.findUnique({ where });
  // Re-observing a revision must not reset its exhausted retry budget.
  if (existing?.runId === runId && ['pending', 'published', 'failed'].includes(existing.state)) return;
  await tx.reviewPublication.upsert({ where,
    create: { repositoryId, pullRequestNumber: number, runId },
    update: { runId, state: 'pending', attempts: 0, nextAttemptAt: new Date(), error: null, diagnostics: Prisma.DbNull },
  });
}

/** Resolve live revisions while holding the PR lock. Any newly observed pair becomes
 * durable work even when its webhook has not arrived. The dispatcher repairs Redis. */
export async function observeLiveTarget(tx: Tx, scope: GitHubScope, number: number, client: GitHubRepositoryClient) {
  const live = await client.pullRequest(number);
  if (live.repositoryId !== scope.repositoryId || live.number !== number) throw new Error('GitHub repository scope mismatch');
  const where = pullKey(scope.repositoryId, number);
  if (live.state !== 'open' || live.draft) {
    await tx.pullRequest.updateMany({ where: { repositoryId: scope.repositoryId, number }, data: { eligible: false } });
    await tx.reviewPublication.updateMany({ where: { repositoryId: scope.repositoryId, pullRequestNumber: number, state: 'pending' }, data: { state: 'cancelled', error: 'PR is closed or draft' } });
    return null;
  }
  const input = inputSchema.parse({ source: 'github', repositoryId: scope.repositoryId, pullRequestNumber: number, baseSha: live.baseSha, headSha: live.headSha });
  const configuration = { ...githubConfig, modelEnabled: process.env.MODEL_ENRICHMENT_ENABLED === '1' };
  const identity = runIdentity(input, configuration);
  const previous = await tx.pullRequest.findUnique({ where });
  // Preserve a maintainer-requested attempt while this exact comparison is current.
  const desired = previous ? await tx.reviewRun.findUnique({ where: { logicalKey: previous.desiredRunKey } }) : null;
  const selected = desired && desired.baseSha === input.baseSha && desired.headSha === input.headSha &&
    desired.configurationDigest === identity.configurationDigest ? desired : null;
  let run = selected ?? await tx.reviewRun.upsert({ where: { logicalKey: identity.logicalKey },
    create: { ...input, ...identity, configuration, installationId: scope.installationId, grantVersion: scope.grantVersion }, update: {},
  });
  if (run.state === 'cancelled' || run.grantVersion !== scope.grantVersion) {
    run = await tx.reviewRun.update({ where: { id: run.id }, data: {
      ...(run.state === 'cancelled' ? { state: 'queued', error: null } : {}),
      installationId: scope.installationId, grantVersion: scope.grantVersion,
    } });
  }
  const completed = run.state === 'completed' && run.report !== null;
  const pr = await tx.pullRequest.upsert({ where,
    create: { repositoryId: scope.repositoryId, number, title: live.title ?? 'Pull request', desiredRunKey: run.logicalKey, baseSha: run.baseSha, headSha: run.headSha, ...(completed ? { latestRunId: run.id } : {}) },
    update: { ...(live.title ? { title: live.title } : {}), desiredRunKey: run.logicalKey, baseSha: run.baseSha, headSha: run.headSha, eligible: true, ...(completed ? { latestRunId: run.id } : {}) },
  });
  if (previous?.desiredRunKey !== run.logicalKey) {
    await tx.inlinePublication.updateMany({ where: { state: 'pending', runId: { not: run.id },
      run: { source: 'github', repositoryId: scope.repositoryId, pullRequestNumber: number } },
      data: { state: 'superseded', reason: 'PR comparison changed before inline publication; evidence retained in report' } });
    await tx.inlinePublication.updateMany({ where: { runId: run.id, state: 'superseded' }, data: { state: 'pending', reason: null } });
  }
  if (completed || (previous?.commentId && previous.desiredRunKey !== run.logicalKey)) {
    await publicationIntent(tx, scope.repositoryId, number, run.id);
  }
  return { pr, run };
}

/** Report, current pointer and publication intent commit or roll back together. */
export async function finalizeGitHubReview(db: PrismaClient, runId: string, rawReport: Report, client: GitHubRepositoryClient) {
  const report = reportSchema.parse(rawReport);
  const run = await db.reviewRun.findUniqueOrThrow({ where: { id: runId } });
  if (report.runId !== run.id || report.logicalKey !== run.logicalKey || report.configurationDigest !== run.configurationDigest ||
      JSON.stringify(inputSchema.parse(run)) !== JSON.stringify(report.input)) throw new Error('Report identity mismatch');
  const scope = await repositoryScope(db, run.installationId!, run.repositoryId, run.grantVersion!);
  await db.$transaction(async tx => {
    await lockPullRequest(tx, scope, run.pullRequestNumber);
    const target = await observeLiveTarget(tx, scope, run.pullRequestNumber, client);
    const completedReport = await snapshotFindingHistory(tx, report);
    const stored = await tx.reviewRun.updateMany({ where: { id: runId, grantVersion: scope.grantVersion, state: { in: ['queued', 'running', 'failed'] } }, data: {
      report: completedReport as Prisma.InputJsonValue, state: 'completed', completedAt: new Date(), error: null,
    } });
    if (!stored.count || !target || target.pr.desiredRunKey !== run.logicalKey || target.pr.baseSha !== run.baseSha || target.pr.headSha !== run.headSha) return;
    await inlineIntents(tx, completedReport);
    const advanced = await tx.pullRequest.updateMany({ where: {
      repositoryId: run.repositoryId, number: run.pullRequestNumber, eligible: true,
      desiredRunKey: run.logicalKey, baseSha: run.baseSha, headSha: run.headSha,
    }, data: { latestRunId: run.id } });
    if (advanced.count) await publicationIntent(tx, run.repositoryId, run.pullRequestNumber, run.id);
  }, reviewTransactionOptions);
}

/** Shared pointer reader for the future authenticated dashboard. */
export async function readCurrentReview(db: PrismaClient, repositoryId: string, number: number) {
  return db.pullRequest.findUnique({ where: pullKey(repositoryId, number), include: { latestRun: true, publication: true } });
}
