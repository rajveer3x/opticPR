import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';
import pino from 'pino';
import { configSchema, inputSchema, type AnalysisConfig, type ReviewInput } from '@opticpr/contracts';
import { PrismaClient, Prisma } from '@opticpr/database';

export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2));
export const queueName = process.env.REVIEW_QUEUE ?? 'opticpr-reviews';
if (!/^[A-Za-z0-9_-]{1,100}$/.test(queueName)) throw new Error('Invalid REVIEW_QUEUE');
export { Queue, Worker } from 'bullmq';

export function redisOptions(): RedisOptions {
  const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:63799/0');
  if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error('REDIS_URL must use redis or rediss');
  const db = Number(url.pathname.slice(1) || '0');
  if (!Number.isInteger(db) || db < 0) throw new Error('Invalid Redis database');
  return {
    host: url.hostname, port: Number(url.port || 6379), db,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    connectTimeout: 1000, maxRetriesPerRequest: 1, retryStrategy: () => null,
  };
}

export function createQueue(name = queueName): Queue {
  const queue = new Queue(name, { connection: { ...redisOptions(), retryStrategy: times => Math.min(times * 200, 2000) } });
  queue.on('error', () => logger.error('Review queue connection failed'));
  return queue;
}

export async function readiness(db: PrismaClient) {
  const [postgresql, redis] = await Promise.all([
    db.$queryRaw`SELECT "id"::text FROM "ReviewRun"
      UNION ALL SELECT "id"::text FROM "IntakeOutbox"
      UNION ALL SELECT "id" FROM "WebhookReceipt"
      UNION ALL SELECT "id" FROM "GitHubRepository"
      UNION ALL SELECT "repositoryId" FROM "PullRequest"
      UNION ALL SELECT "repositoryId" FROM "ReviewPublication"
      UNION ALL SELECT "runId"::text FROM "RunObservation"
      UNION ALL SELECT "runId"::text FROM "RunEnrichment"
      UNION ALL SELECT "runId"::text FROM "FindingSnapshot"
      UNION ALL SELECT "id"::text FROM "Finding"
      UNION ALL SELECT "id"::text FROM "FindingDecision"
      UNION ALL SELECT "id" FROM "GitHubInstallation"
      UNION ALL SELECT "id" FROM "DashboardSession"
      UNION ALL SELECT "id"::text FROM "ReviewRetry" LIMIT 1`.then(() => true, () => false),
    (async () => {
      const client = new Redis({ ...redisOptions(), lazyConnect: true });
      client.on('error', () => {});
      try { await client.connect(); return await client.ping() === 'PONG'; }
      catch { return false; }
      finally { client.disconnect(); }
    })(),
  ]);
  return {
    ready: postgresql && redis,
    dependencies: { postgresql: postgresql ? 'up' : 'down', redis: redis ? 'up' : 'down' },
  };
}

export async function requireReady(db: PrismaClient): Promise<void> {
  const status = await readiness(db);
  if (!status.ready) {
    const failed = Object.entries(status.dependencies).filter(([, state]) => state === 'down').map(([name]) => name);
    throw new Error(`Dependencies unavailable: ${failed.join(', ')} (PostgreSQL also requires applied migrations)`);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function runIdentity(rawInput: ReviewInput, rawConfig: AnalysisConfig, attempt = 0) {
  const input = inputSchema.parse(rawInput);
  const configuration = configSchema.parse(rawConfig);
  const configurationDigest = digest(configuration);
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new Error('Invalid review attempt');
  return { logicalKey: digest({ ...input, configurationDigest, ...(attempt ? { attempt } : {}) }), configurationDigest };
}

/** Persist first. Replaying repairs a queue restart or a crash before enqueue. */
export async function scheduleRun(db: PrismaClient, queue: Queue, input: ReviewInput, configuration: AnalysisConfig) {
  await requireReady(db);
  input = inputSchema.parse(input); configuration = configSchema.parse(configuration);
  const identity = runIdentity(input, configuration);
  const run = await db.reviewRun.create({ data: { ...input, ...identity, configuration } }).catch(error => {
    // PostgreSQL's unique constraint arbitrates concurrent first replays.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return db.reviewRun.findUniqueOrThrow({ where: { logicalKey: identity.logicalKey } });
    }
    throw error;
  });
  if (run.state !== 'completed') {
    if (run.state === 'failed') {
      await db.reviewRun.updateMany({ where: { id: run.id, state: 'failed' }, data: { state: 'queued', error: null } });
    }
    const existing = await queue.getJob(identity.logicalKey);
    if (existing && await existing.getState() === 'failed') {
      await existing.retry();
    } else {
      await queue.add('review', { runId: run.id }, {
        jobId: identity.logicalKey, attempts: 3, backoff: { type: 'exponential', delay: 500 },
        removeOnComplete: true, removeOnFail: false,
      });
    }
  }
  return run;
}

export async function waitForReport(db: PrismaClient, runId: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await db.reviewRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.state === 'completed' && run.report) return run;
    if (run.state === 'cancelled') throw new Error(`Run ${runId} was cancelled; repository access was revoked`);
    if (run.state === 'failed') throw new Error(`Run ${runId} failed; replay to retry`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms; check the worker and replay to recover`);
}

export { AccessRevokedError, lockInstallation, repositoryScope, revokeRepositories } from './github-access.js';

/** Safe to repeat after an ambiguous Redis response; BullMQ deduplicates by key. */
export async function enqueueRun(queue: Queue, run: { id: string; logicalKey: string }) {
  const existing = await queue.getJob(run.logicalKey);
  if (existing && await existing.getState() === 'failed') await existing.retry();
  else await queue.add('review', { runId: run.id }, {
    jobId: run.logicalKey, attempts: 3, backoff: { type: 'exponential', delay: 500 },
    removeOnComplete: true, removeOnFail: false,
  });
}

export { appendFindingDecision } from './finding-decisions.js';

/** Public links contain only immutable IDs, never credentials or source content. */
export function dashboardRunUrl(runId: string, findingId?: string, origin = process.env.DASHBOARD_ORIGIN): string | undefined {
  if (!origin) return;
  queueLinkId(runId); if (findingId) queueLinkId(findingId);
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Invalid DASHBOARD_ORIGIN');
  url.pathname = `/runs/${runId}`;
  if (findingId) url.searchParams.set('finding', findingId);
  return url.href;
}
function queueLinkId(id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid dashboard link ID');
}
