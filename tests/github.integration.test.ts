import { createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { reportSchema, type GitHubScope } from '../packages/contracts/src/index.js';
import { PrismaClient } from '../packages/database/src/index.js';
import type { GitHubClientFactory } from '../packages/repository/src/index.js';
import { createQueue, repositoryScope, waitForReport, type Queue, type Worker } from '../packages/runtime/src/index.js';
import { createApp } from '../apps/api/src/app.js';
import { createWorker } from '../apps/worker/src/worker.js';
import { createDispatcher } from '../apps/worker/src/dispatcher.js';

const exec = promisify(execFile);
const namespace = `intake_test_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set('schema', namespace);
const admin = new PrismaClient();
const db = new PrismaClient({ datasourceUrl: url.toString() });
const secret = 'local-integration-webhook-secret';
const repository = { id: 200, name: 'selected-repo', owner: { login: 'installation-owner' } };
const selectedRepository = { id: repository.id, name: repository.name, full_name: `${repository.owner.login}/${repository.name}`, private: true };
const installation = { id: 100 };
const headSha = 'b'.repeat(40);
const live = new Map<number, { baseSha: string; headSha: string; state: string; draft: boolean }>();
const calls: { operation: string; scope: GitHubScope; baseSha?: string }[] = [];
let onCompare: (() => Promise<void>) | undefined;
const clients: GitHubClientFactory = (scope, assertAccess) => ({
  async pullRequest(number) {
    await assertAccess(); calls.push({ operation: 'pr', scope });
    return { number, repositoryId: scope.repositoryId, ...(live.get(number) ?? { baseSha: 'a'.repeat(40), headSha, state: 'open', draft: false }) };
  },
  async compare(baseSha, headSha) {
    await assertAccess(); calls.push({ operation: 'compare', scope, baseSha });
    await onCompare?.();
    return [{ path: 'src/index.ts', hunk: `@@\n-${baseSha}\n+${headSha}`, status: 'modified' }];
  },
  async file() { await assertAccess(); return 'source'; },
});
let server: Server;
let origin: string;
let queue: Queue;
let worker: Worker;
let dispatcher: ReturnType<typeof createDispatcher>;
let redisStopped = false;

async function send(event: string, payload: unknown, id = randomUUID(), signature?: string) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signed = signature ?? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return fetch(`${origin}/webhooks/github`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-github-delivery': id, 'x-github-event': event, 'x-hub-signature-256': signed,
  }, body: raw });
}
function pull(number: number, action = 'opened', extra: Record<string, unknown> = {}) {
  return { action, installation, repository, number, pull_request: { number, state: 'open', draft: false }, ...extra };
}
async function runFor(number: number) {
  return db.reviewRun.findFirstOrThrow({ where: { repositoryId: '200', pullRequestNumber: number }, orderBy: { createdAt: 'desc' } });
}
async function select(action = 'created') {
  const payload = action === 'created' ? { action, installation, repositories: [selectedRepository] } : { action: 'added', installation, repositories_added: [selectedRepository] };
  const response = await send(action === 'created' ? 'installation' : 'installation_repositories', payload);
  expect(response.status).toBe(202);
}

beforeAll(async () => {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
  const directory = new URL('../packages/database/prisma/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d/.test(name)).sort()) {
    const migration = await readFile(new URL(`${name}/migration.sql`, directory), 'utf8');
    for (const statement of migration.split(';').map(part => part.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  }
  queue = createQueue(namespace);
  await queue.waitUntilReady();
  dispatcher = createDispatcher(db, queue, clients);
  worker = createWorker(db, namespace, clients);
  await worker.waitUntilReady();
  server = createApp(db, { webhookSecret: secret }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  origin = `http://127.0.0.1:${address.port}`;
  await select();
}, 30000);

afterAll(async () => {
  if (redisStopped) await exec('docker', ['compose', 'start', '--wait', 'redis'], { timeout: 30000 });
  onCompare = undefined;
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await worker?.close(); await dispatcher?.close();
  await queue?.obliterate({ force: true }); await queue?.close();
  await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await admin.$disconnect();
}, 30000);

it('rejects invalid signatures without a receipt, outbox entry or run', async () => {
  const before = await db.webhookReceipt.count();
  const response = await send('pull_request', pull(1), randomUUID(), `sha256=${'0'.repeat(64)}`);
  expect(response.status).toBe(401);
  expect(await db.webhookReceipt.count()).toBe(before);
  expect(await db.intakeOutbox.count()).toBe(0);
  expect(await db.reviewRun.count()).toBe(0);
});

it('rolls the receipt back when durable outbox storage fails and permits redelivery', async () => {
  const id = randomUUID();
  await db.$executeRawUnsafe('ALTER TABLE "IntakeOutbox" ADD CONSTRAINT "test_storage_failure" CHECK ("pullRequestNumber" <> 99)');
  try {
    expect((await send('pull_request', pull(99), id)).status).toBe(503);
    expect(await db.webhookReceipt.findUnique({ where: { id } })).toBeNull();
    expect(await db.intakeOutbox.count({ where: { deliveryId: id } })).toBe(0);
  } finally { await db.$executeRawUnsafe('ALTER TABLE "IntakeOutbox" DROP CONSTRAINT "test_storage_failure"'); }
  expect((await send('pull_request', pull(99), id)).status).toBe(202);
  await dispatcher.tick();
  await waitForReport(db, (await runFor(99)).id);
});

it('deduplicates ten concurrent deliveries, measures acknowledgment p95 and queues one stable run', async () => {
  const id = randomUUID();
  const latencies: number[] = [];
  const results = await Promise.all(Array.from({ length: 10 }, async () => {
    const start = performance.now();
    const response = await send('pull_request', pull(2), id);
    latencies.push(performance.now() - start);
    expect([200, 202]).toContain(response.status);
    return response.json();
  }));
  expect(results.filter(result => !result.duplicate)).toHaveLength(1);
  expect(await db.webhookReceipt.count({ where: { id } })).toBe(1);
  expect(await db.intakeOutbox.count({ where: { deliveryId: id } })).toBe(1);
  expect(await db.reviewRun.count({ where: { pullRequestNumber: 2 } })).toBe(0);
  const p95 = latencies.sort((a, b) => a - b)[Math.ceil(0.95 * latencies.length) - 1]!;
  console.log(`GitHub acknowledgment p95: ${p95.toFixed(1)}ms (10 concurrent deliveries, target 1000ms)`);
  expect(p95).toBeLessThan(1000);
  await worker.pause();
  try {
    await dispatcher.tick();
    const run = await runFor(2);
    expect((await queue.getJob(run.logicalKey))?.data).toEqual({ runId: run.id });
    expect(await db.reviewRun.count({ where: { pullRequestNumber: 2 } })).toBe(1);
  } finally { await worker.resume(); }
  const run = await waitForReport(db, (await runFor(2)).id);
  expect(reportSchema.parse(run.report)).toMatchObject({ source: 'github', coverage: { status: 'partial', analyzedFiles: [] }, findings: [] });
  expect((await send('pull_request', pull(2, 'synchronize'), id)).status).toBe(409);
  // Live reports require an authenticated dashboard session.
  expect((await fetch(`${origin}/api/runs/${run.id}`)).status).toBe(401);
});

it.each(['opened', 'reopened', 'synchronize', 'ready_for_review'])('accepts an eligible %s PR', async action => {
  const number = 10 + ['opened', 'reopened', 'synchronize', 'ready_for_review'].indexOf(action);
  const response = await send('pull_request', pull(number, action));
  expect(await response.json()).toMatchObject({ disposition: 'accepted' });
  await dispatcher.tick();
  await waitForReport(db, (await runFor(number)).id);
});

it('skips closed, draft, title-only and unselected events and rechecks live eligibility', async () => {
  for (const event of [
    pull(20, 'closed', { pull_request: { number: 20, state: 'closed', draft: false } }),
    pull(20, 'opened', { pull_request: { number: 20, state: 'open', draft: true } }),
    pull(20, 'edited', { changes: { title: { from: 'old title' } } }),
    pull(20, 'edited'),
    pull(20, 'labeled'),
  ]) expect(await (await send('pull_request', event)).json()).toMatchObject({ disposition: 'ignored' });
  expect(await (await send('pull_request', pull(20, 'opened', { repository: { ...repository, id: 201 } }))).json()).toMatchObject({ disposition: 'unselected' });
  expect(await (await send('pull_request', pull(20, 'opened', { installation: { id: 101 } }))).json()).toMatchObject({ disposition: 'unselected' });
  expect(await db.intakeOutbox.count({ where: { pullRequestNumber: 20 } })).toBe(0);
  live.set(21, { baseSha: 'a'.repeat(40), headSha, state: 'closed', draft: false });
  await send('pull_request', pull(21));
  await dispatcher.tick();
  expect(await db.reviewRun.count({ where: { pullRequestNumber: 21 } })).toBe(0);
  expect(await db.intakeOutbox.findFirst({ where: { pullRequestNumber: 21 } })).toMatchObject({ state: 'cancelled' });
});

it.each(['closed', 'draft'])('skips a PR that becomes %s after dispatch', async eligibility => {
  const number = eligibility === 'closed' ? 23 : 24;
  await worker.pause();
  await send('pull_request', pull(number));
  await dispatcher.tick();
  const run = await runFor(number);
  const comparisons = calls.filter(call => call.operation === 'compare').length;
  live.set(number, { baseSha: 'a'.repeat(40), headSha, state: eligibility === 'closed' ? 'closed' : 'open', draft: eligibility === 'draft' });
  await worker.resume();
  for (let attempt = 0; attempt < 100 && (await db.reviewRun.findUniqueOrThrow({ where: { id: run.id } })).state !== 'cancelled'; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(await db.reviewRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ state: 'cancelled', report: null });
  expect(calls.filter(call => call.operation === 'compare')).toHaveLength(comparisons);
});

it('resolves live SHAs, gives a base retarget a new key and diff, and ignores a title-only edit', async () => {
  await send('pull_request', pull(22));
  await dispatcher.tick();
  const first = await waitForReport(db, (await runFor(22)).id);
  live.set(22, { baseSha: 'c'.repeat(40), headSha, state: 'open', draft: false });
  // Webhook SHAs deliberately remain stale; the dispatcher must fetch the current pair.
  await send('pull_request', pull(22, 'edited', { changes: { base: { ref: { from: 'main' }, sha: { from: 'a'.repeat(40) } } } }));
  await dispatcher.tick();
  const second = await waitForReport(db, (await runFor(22)).id);
  expect(second.id).not.toBe(first.id);
  expect(second.logicalKey).not.toBe(first.logicalKey);
  expect(second.headSha).toBe(first.headSha);
  expect(second.baseSha).toBe('c'.repeat(40));
  const oldReport = reportSchema.parse(first.report), newReport = reportSchema.parse(second.report);
  expect(newReport.comparison).not.toEqual(oldReport.comparison);
  expect(newReport.comparison![0]!.hunk).toContain('c'.repeat(40));
  await send('pull_request', pull(22, 'edited', { changes: { title: { from: 'old title' } } }));
  await dispatcher.tick();
  expect(await db.reviewRun.count({ where: { pullRequestNumber: 22 } })).toBe(2);
  expect(calls.every(call => call.scope.installationId === '100' && call.scope.repositoryId === '200')).toBe(true);
});

it('acknowledges while Redis is stopped, recovers dispatch after restart and restores lost acknowledged jobs', async () => {
  await worker.pause();
  try {
    await exec('docker', ['compose', 'stop', 'redis'], { timeout: 30000 });
    redisStopped = true;
    const id = randomUUID();
    expect((await send('pull_request', pull(30), id)).status).toBe(202);
    // Run persistence succeeds even though enqueue fails.
    await dispatcher.tick().catch(() => {});
    expect(await db.intakeOutbox.findUnique({ where: { deliveryId: id } })).toMatchObject({ state: 'pending' });
    expect((await runFor(30)).state).toBe('queued');
    await exec('docker', ['compose', 'start', '--wait', 'redis'], { timeout: 30000 });
    redisStopped = false;
    await queue.waitUntilReady();
    await db.intakeOutbox.updateMany({ where: { deliveryId: id }, data: { nextAttemptAt: new Date(0) } });
    await dispatcher.tick();
    const run = await runFor(30);
    expect(await db.intakeOutbox.findUnique({ where: { deliveryId: id } })).toMatchObject({ state: 'dispatched', runId: run.id });
    expect(await queue.getJob(run.logicalKey)).toBeTruthy();
    // Simulate loss of the queue after an acknowledged dispatch, plus an expired worker.
    await queue.drain();
    await db.reviewRun.update({ where: { id: run.id }, data: { state: 'running' } });
    const restartedDispatcher = createDispatcher(db, queue, clients);
    await restartedDispatcher.tick();
    expect((await queue.getJob(run.logicalKey))?.data).toEqual({ runId: run.id });
    await restartedDispatcher.close();
  } finally {
    if (redisStopped) { await exec('docker', ['compose', 'start', '--wait', 'redis'], { timeout: 30000 }); redisStopped = false; }
    await worker.resume();
  }
  expect((await waitForReport(db, (await runFor(30)).id)).state).toBe('completed');
}, 60000);

it('recovers an expired dispatcher lease without requiring webhook redelivery', async () => {
  const id = randomUUID();
  await send('pull_request', pull(31), id);
  await db.intakeOutbox.update({ where: { deliveryId: id }, data: { leaseUntil: new Date(0), leaseToken: randomUUID() } });
  await dispatcher.tick();
  await waitForReport(db, (await runFor(31)).id);
});

it('cancels pending, queued and in-flight work on removal and fences old grants after re-addition', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  onCompare = async () => { entered(); await gate; };
  try {
    await send('pull_request', pull(40));
    await dispatcher.tick();
    await started;
    await send('pull_request', pull(41));
    await dispatcher.tick(); // Queued behind in-flight run 40 at concurrency one.
    await send('pull_request', pull(42)); // Pending outbox, not yet dispatched.
    const oldScope = await repositoryScope(db, '100', '200');
    const response = await send('installation_repositories', { action: 'removed', installation, repositories_removed: [selectedRepository] });
    expect(await response.json()).toMatchObject({ disposition: 'revoked' });
    expect(await db.reviewRun.findMany({ where: { pullRequestNumber: { in: [40, 41] } } })).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'cancelled' }), expect.objectContaining({ state: 'cancelled' })]));
    expect(await db.intakeOutbox.count({ where: { pullRequestNumber: { in: [40, 41, 42] }, state: 'cancelled' } })).toBe(3);
    await expect(repositoryScope(db, '100', '200')).rejects.toThrow('revoked');
    const count = calls.length;
    release(); onCompare = undefined;
    // Wait for the already-started worker to leave its finalization path.
    const activeJob = await queue.getJob((await runFor(40)).logicalKey);
    for (let attempt = 0; attempt < 100 && activeJob && await activeJob.getState() === 'active'; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    await dispatcher.tick();
    expect(calls).toHaveLength(count);
    expect(await runFor(40)).toMatchObject({ state: 'cancelled', report: null });
    expect(await queue.getJob((await runFor(41)).logicalKey)).toBeUndefined();
    expect(await (await send('pull_request', pull(43))).json()).toMatchObject({ disposition: 'unselected' });
    await select('added');
    await expect(repositoryScope(db, '100', '200', oldScope.grantVersion)).rejects.toThrow('revoked');
    expect((await repositoryScope(db, '100', '200')).grantVersion).not.toBe(oldScope.grantVersion);
    await dispatcher.tick();
    expect(await db.reviewRun.count({ where: { pullRequestNumber: 42 } })).toBe(0);
    await send('pull_request', pull(44));
    await dispatcher.tick();
    await waitForReport(db, (await runFor(44)).id);
    await send('installation', { action: 'deleted', installation });
    await expect(repositoryScope(db, '100', '200')).rejects.toThrow('revoked');
    expect(await (await send('pull_request', pull(45))).json()).toMatchObject({ disposition: 'unselected' });
  } finally { release(); onCompare = undefined; }
}, 30000);
