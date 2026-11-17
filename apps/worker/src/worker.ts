import { configSchema, inputSchema, queueJobSchema } from '@opticpr/contracts';
import { PrismaClient, type Prisma } from '@opticpr/database';
import { FixtureRepositoryAdapter, GitHubRepositoryAdapter, IneligiblePullRequestError, githubClientsFromEnv, type GitHubClientFactory, type RepositoryAdapter } from '@opticpr/repository';
import { Worker, queueName, redisOptions, logger, runIdentity, repositoryScope, AccessRevokedError } from '@opticpr/runtime';
import { analyzeFixture, analyzeGitHubIntake } from './analyze.js';
import { analyzeLocal, type AnalysisServices } from './local-analysis.js';
import { finalizeGitHubReview } from './current-review.js';
import { snapshotFindingHistory } from './finding-history.js';

export function createWorker(db: PrismaClient, name = queueName, clients: GitHubClientFactory = githubClientsFromEnv(), services: AnalysisServices = {}) {
  const worker = new Worker(name, async job => {
    const { runId } = queueJobSchema.parse(job.data);
    const started = Date.now();
    const run = await db.reviewRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.state === 'completed' || run.state === 'cancelled') return;
    const fence = { id: runId, grantVersion: run.grantVersion, state: { in: ['queued', 'running', 'failed'] } };
    if (!(await db.reviewRun.updateMany({ where: fence, data: { state: 'running', startedAt: new Date(), error: null } })).count) return;
    let adapter: RepositoryAdapter | undefined;
    let githubClient: ReturnType<GitHubClientFactory> | undefined;
    try {
      const input = inputSchema.parse(run);
      const configuration = configSchema.parse(run.configuration);
      const identity = runIdentity(input, configuration);
      if (identity.logicalKey !== run.logicalKey || identity.configurationDigest !== run.configurationDigest) throw new Error('Stored run identity failed validation');
      if (input.source === 'github') {
        if (configuration.adapter !== 'github-rest-v1' || !run.installationId || !run.grantVersion) throw new Error('Invalid GitHub run scope');
        const scope = await repositoryScope(db, run.installationId, run.repositoryId, run.grantVersion);
        const assertAccess = async () => { await repositoryScope(db, scope.installationId, scope.repositoryId, scope.grantVersion); };
        githubClient = clients(scope, assertAccess);
        adapter = new GitHubRepositoryAdapter(scope, input.pullRequestNumber, githubClient, input);
      } else {
        if (configuration.adapter !== 'pagination-bundle-v1') throw new Error('Invalid fixture configuration');
        adapter = await FixtureRepositoryAdapter.open(input);
      }
      const report = configuration.analyzer === 'local-analysis'
        ? await analyzeLocal(db, adapter, input, configuration, { runId, ...identity }, services)
        : await (input.source === 'fixture' ? analyzeFixture : analyzeGitHubIntake)(adapter, input, configuration, { runId, ...identity });
      if (githubClient) await finalizeGitHubReview(db, runId, report, githubClient);
      else await db.$transaction(async tx => {
        const completedReport = await snapshotFindingHistory(tx, report);
        await tx.reviewRun.updateMany({ where: fence, data: {
          report: completedReport as Prisma.InputJsonValue, state: 'completed', completedAt: new Date(), error: null,
        } });
      });
      logger.info({ runId, durationMs: Date.now() - started }, 'Review report stored');
    } catch (error) {
      const cancelled = error instanceof AccessRevokedError || error instanceof IneligiblePullRequestError;
      const terminal = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      await db.reviewRun.updateMany({ where: fence, data: {
        state: cancelled ? 'cancelled' : terminal ? 'failed' : 'queued', error: cancelled ? (error instanceof IneligiblePullRequestError ? 'PR is closed or draft' : 'Repository access revoked') : 'Review failed; inspect worker configuration and dependencies.',
      } });
      logger.error({ runId, durationMs: Date.now() - started }, 'Review failed');
      if (!cancelled) throw error;
    } finally { await adapter?.close(); }
  }, { connection: { ...redisOptions(), maxRetriesPerRequest: null, retryStrategy: times => Math.min(times * 200, 2000) }, concurrency: 1 });
  worker.on('error', () => logger.error('Worker dependency connection failed'));
  return worker;
}
