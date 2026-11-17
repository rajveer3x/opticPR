import { createHmac, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PrismaClient } from '../packages/database/src/index.js';
import { githubConfig, reportSchema, type Report } from '../packages/contracts/src/index.js';
import { GitHubRepositoryAdapter, type GitHubPublicationClientFactory, type SummaryComment } from '../packages/repository/src/index.js';
import { createQueue, repositoryScope, waitForReport, type Worker } from '../packages/runtime/src/index.js';
import { createApp } from '../apps/api/src/app.js';
import { createWorker } from '../apps/worker/src/worker.js';
import { createDispatcher } from '../apps/worker/src/dispatcher.js';
import { finalizeGitHubReview, readCurrentReview } from '../apps/worker/src/current-review.js';
import { analyzeGitHubIntake } from '../apps/worker/src/analyze.js';
import { createPublisher, retryPublication, summaryMarker } from '../apps/worker/src/publication.js';

const namespace = `publication_test_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.DATABASE_URL!);
url.searchParams.set('schema', namespace);
const admin = new PrismaClient();
const db = new PrismaClient({ datasourceUrl: url.toString() });
const live = new Map<number, { baseSha: string; headSha: string; state: string; draft: boolean }>();
const comments = new Map<number, SummaryComment[]>();
const defaults = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), state: 'open', draft: false };
const secret = 'test-publication-secret';
let nextComment = 1;
let writes = 0;
let lostResponse = false;
let failRemote: unknown;
let afterWrite: ((number: number) => void) | undefined;
let compareGate: ((headSha: string) => Promise<void>) | undefined;
const clients: GitHubPublicationClientFactory = (scope, assertAccess) => ({
  async pullRequest(number) { await assertAccess(); return { number, repositoryId: scope.repositoryId, ...(live.get(number) ?? defaults) }; },
  async compare(baseSha, headSha) { await assertAccess(); await compareGate?.(headSha); return [{ path: 'src/index.ts', hunk: `@@\n-${baseSha}\n+${headSha}` }]; },
  async file() { await assertAccess(); return 'source'; },
  async comments(number) { await assertAccess(); if (failRemote) throw failRemote; return [...(comments.get(number) ?? [])]; },
  async createComment(number, body) {
    await assertAccess(); writes++;
    const id = String(nextComment++);
    comments.set(number, [...(comments.get(number) ?? []), { id, body, appOwned: true }]);
    afterWrite?.(number);
    if (lostResponse) { lostResponse = false; throw new Error('Response lost after successful create'); }
    return id;
  },
  async updateComment(id, body) {
    await assertAccess(); writes++;
    for (const [number, values] of comments) {
      const comment = values.find(comment => comment.id === id);
      if (comment) { comment.body = body; afterWrite?.(number); return; }
    }
    throw Object.assign(new Error('deleted'), { status: 404 });
  },
});
let server: Server;
let origin: string;
let queue: ReturnType<typeof createQueue>;
let worker: Worker;
let secondWorker: Worker | undefined;
let dispatcher: ReturnType<typeof createDispatcher>;
let publisher: ReturnType<typeof createPublisher>;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function send(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const response = await fetch(`${origin}/webhooks/github`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-github-delivery': randomUUID(), 'x-github-event': event,
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  }, body });
  expect(response.status).toBe(202);
}
async function dispatch(number: number, headSha = defaults.headSha, baseSha = defaults.baseSha) {
  live.set(number, { ...defaults, headSha, baseSha });
  await send('pull_request', { action: 'synchronize', installation: { id: 100 }, repository: { id: 200, name: 'repo', owner: { login: 'owner' } }, number, pull_request: { number, state: 'open', draft: false } });
  await dispatcher.tick();
  return db.reviewRun.findFirstOrThrow({ where: { repositoryId: '200', pullRequestNumber: number, headSha, baseSha } });
}
async function prepareReport(run: Awaited<ReturnType<typeof dispatch>>): Promise<Report> {
  const scope = await repositoryScope(db, '100', '200');
  const client = clients(scope, async () => { await repositoryScope(db, '100', '200', scope.grantVersion); });
  const input = { source: 'github' as const, repositoryId: '200', pullRequestNumber: run.pullRequestNumber, baseSha: run.baseSha, headSha: run.headSha };
  return analyzeGitHubIntake(new GitHubRepositoryAdapter(scope, run.pullRequestNumber, client, input), input, githubConfig,
    { runId: run.id, logicalKey: run.logicalKey, configurationDigest: run.configurationDigest });
}
async function finalize(run: Awaited<ReturnType<typeof dispatch>>, report?: Report) {
  const scope = await repositoryScope(db, '100', '200');
  await finalizeGitHubReview(db, run.id, report ?? await prepareReport(run), clients(scope, async () => { await repositoryScope(db, '100', '200', scope.grantVersion); }));
}
async function pointer(number: number) { return readCurrentReview(db, '200', number); }
async function intent(number: number) { return db.reviewPublication.findUniqueOrThrow({ where: { repositoryId_pullRequestNumber: { repositoryId: '200', pullRequestNumber: number } } }); }
async function due(number: number) { await db.reviewPublication.update({ where: { repositoryId_pullRequestNumber: { repositoryId: '200', pullRequestNumber: number } }, data: { nextAttemptAt: new Date(0) } }); }
function visible(number: number) { return (comments.get(number) ?? []).filter(comment => comment.appOwned); }

beforeAll(async () => {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
  const directory = new URL('../packages/database/prisma/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d/.test(name)).sort()) {
    const sql = await readFile(new URL(`${name}/migration.sql`, directory), 'utf8');
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  }
  queue = createQueue(namespace);
  await queue.waitUntilReady();
  dispatcher = createDispatcher(db, queue, clients);
  publisher = createPublisher(db, clients);
  worker = createWorker(db, namespace, clients);
  await worker.waitUntilReady();
  await worker.pause();
  server = createApp(db, { webhookSecret: secret }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server');
  origin = `http://127.0.0.1:${address.port}`;
  await send('installation', { action: 'created', installation: { id: 100 }, repositories: [{ id: 200, name: 'repo', full_name: 'owner/repo' }] });
}, 30000);

afterAll(async () => {
  compareGate = undefined; afterWrite = undefined; failRemote = undefined;
  await new Promise<void>(resolve => server?.close(() => resolve()));
  await secondWorker?.close(); await worker?.close(); await dispatcher?.close(); await publisher?.close();
  await queue?.obliterate({ force: true }); await queue?.close(); await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await admin.$disconnect();
}, 30000);

it('rolls back report and pointer when publication intent fails, then retries through latestRunId', async () => {
  const run = await dispatch(1);
  const report = await prepareReport(run);
  await db.$executeRawUnsafe('ALTER TABLE "ReviewPublication" ADD CONSTRAINT "test_finalize_failure" CHECK ("pullRequestNumber" <> 1)');
  try {
    await expect(finalize(run, report)).rejects.toThrow();
    expect(await db.reviewRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({ state: 'queued', report: null, completedAt: null });
    expect((await pointer(1))?.latestRunId).toBeNull();
    expect(await db.reviewPublication.count()).toBe(0);
    expect(await db.findingSnapshot.count({ where: { runId: run.id } })).toBe(0);
  } finally { await db.$executeRawUnsafe('ALTER TABLE "ReviewPublication" DROP CONSTRAINT "test_finalize_failure"'); }
  await finalize(run, report);
  const current = await pointer(1);
  expect(current?.latestRunId).toBe(run.id);
  expect(reportSchema.parse(current?.latestRun?.report).runId).toBe(run.id);
  expect(await intent(1)).toMatchObject({ runId: run.id, state: 'pending' });
  expect(await db.findingSnapshot.count({ where: { runId: run.id } })).toBe(1);
  await publisher.tick();
  expect(visible(1)).toHaveLength(1);
  expect(visible(1)[0]!.body).toContain(`Reviewed SHA: \`${run.headSha}\``);
  expect(visible(1)[0]!.body).toContain('does not indicate a clean review');
});

it('finishes B on a second worker while A is paused before promotion, then leaves B current', async () => {
  // Remove manually finalized jobs so the gate only pauses this test's A.
  await queue.drain();
  const entered = gate(), release = gate();
  const headA = 'c'.repeat(40), headB = 'd'.repeat(40);
  compareGate = async head => { if (head === headA) { entered.release(); await release.promise; } };
  try {
    const a = await dispatch(2, headA);
    await worker.resume();
    await entered.promise;
    const b = await dispatch(2, headB);
    secondWorker = createWorker(db, namespace, clients);
    await secondWorker.waitUntilReady();
    await waitForReport(db, b.id);
    await publisher.tick();
    release.release();
    await waitForReport(db, a.id);
    await publisher.tick();
    expect((await pointer(2))?.latestRunId).toBe(b.id);
    expect(visible(2)).toHaveLength(1);
    expect(visible(2)[0]!.body).toContain(b.headSha);
    expect(visible(2)[0]!.body).not.toContain(a.headSha);
  } finally {
    release.release(); compareGate = undefined;
    await secondWorker?.close(); secondWorker = undefined;
    await worker.pause();
  }
}, 30000);

it('discards A selected for publication when B completes before the publication lock', async () => {
  await queue.drain();
  const a = await dispatch(3, 'e'.repeat(40));
  await finalize(a);
  const selected = gate(), release = gate();
  const delayed = db.$extends({ query: { reviewPublication: { async findMany({ args, query }) {
    const rows = await query(args); selected.release(); await release.promise; return rows;
  } } } });
  const publishingA = createPublisher(delayed as unknown as PrismaClient, clients).tick();
  try {
    await selected.promise;
    const b = await dispatch(3, 'f'.repeat(40));
    await finalize(b);
    await createPublisher(db, clients).tick();
    release.release(); await publishingA;
    expect((await pointer(3))?.latestRunId).toBe(b.id);
    expect(visible(3)).toHaveLength(1);
    expect(visible(3)[0]!.body).toContain(b.headSha);
    expect(visible(3)[0]!.body).not.toContain(a.headSha);
  } finally { release.release(); await publishingA; }
});

it('keeps the newer base comparison current when an older report with the same head finishes late', async () => {
  const a = await dispatch(11);
  const reportA = await prepareReport(a);
  const b = await dispatch(11, a.headSha, '4'.repeat(40));
  await finalize(b);
  await finalize(a, reportA);
  await publisher.tick();
  expect((await pointer(11))?.latestRunId).toBe(b.id);
  expect(visible(11)).toHaveLength(1);
  expect(visible(11)[0]!.body).toContain(b.baseSha);
  expect(visible(11)[0]!.body).not.toContain(a.baseSha);
});

it('recovers an app-authored marker after an ambiguous create, ignoring a user copy', async () => {
  const run = await dispatch(4);
  await finalize(run);
  comments.set(4, [{ id: '99999', body: summaryMarker('200', 4), appOwned: false }]);
  lostResponse = true;
  await publisher.tick();
  expect(await intent(4)).toMatchObject({ state: 'pending', attempts: 1 });
  expect((await pointer(4))?.commentId).toBeNull();
  expect(visible(4)).toHaveLength(1);
  await due(4);
  await createPublisher(db, clients).tick();
  expect(visible(4)).toHaveLength(1);
  expect((await pointer(4))?.commentId).toBe(visible(4)[0]!.id);
  expect(await intent(4)).toMatchObject({ state: 'published', attempts: 2, runId: run.id });
  // Deletion also recovers without trying to edit an unrelated comment.
  comments.set(4, comments.get(4)!.filter(comment => !comment.appOwned));
  await retryPublication(db, '200', 4); await publisher.tick();
  expect(visible(4)).toHaveLength(1);
});

it.each(['head', 'base'])('rechecks a %s change immediately before publication without a webhook', async kind => {
  const number = kind === 'head' ? 5 : 6;
  const run = await dispatch(number);
  await finalize(run);
  live.set(number, { ...defaults, ...(kind === 'head' ? { headSha: '1'.repeat(40) } : { baseSha: '2'.repeat(40) }) });
  await publisher.tick();
  expect(visible(number)).toHaveLength(0);
  const current = await pointer(number);
  expect(current?.desiredRunKey).not.toBe(run.logicalKey);
  const fresh = await db.reviewRun.findUniqueOrThrow({ where: { logicalKey: current!.desiredRunKey } });
  expect(fresh.state).toBe('queued');
  expect(await intent(number)).toMatchObject({ runId: fresh.id, state: 'waiting' });
  await finalize(fresh);
  await publisher.tick();
  expect(visible(number)[0]!.body).toContain(fresh.headSha);
  expect(visible(number)[0]!.body).toContain(fresh.baseSha);
  expect((await pointer(number))?.latestRunId).toBe(fresh.id);
});

it('reconciles a push during create to pending, then publishes the new report to the same comment', async () => {
  const run = await dispatch(7);
  await finalize(run);
  afterWrite = number => { if (number === 7) { live.set(7, { ...defaults, headSha: '3'.repeat(40) }); afterWrite = undefined; } };
  try { await publisher.tick(); } finally { afterWrite = undefined; }
  expect(visible(7)).toHaveLength(1);
  const id = visible(7)[0]!.id;
  expect(visible(7)[0]!.body).toContain('Review pending');
  expect(visible(7)[0]!.body).toContain('3'.repeat(40));
  expect(visible(7)[0]!.body).not.toContain(`Reviewed SHA: \`${run.headSha}\``);
  const current = await pointer(7);
  const fresh = await db.reviewRun.findUniqueOrThrow({ where: { logicalKey: current!.desiredRunKey } });
  await finalize(fresh); await publisher.tick();
  expect(visible(7)).toHaveLength(1);
  expect(visible(7)[0]!.id).toBe(id);
  expect(visible(7)[0]!.body).toContain(`Reviewed SHA: \`${fresh.headSha}\``);
  expect((await pointer(7))?.latestRunId).toBe(fresh.id);
});

it('serializes two publishers across database clients and produces one create', async () => {
  const run = await dispatch(8);
  await finalize(run);
  const other = new PrismaClient({ datasourceUrl: url.toString() });
  const before = writes;
  try { await Promise.all([publisher.tick(), createPublisher(other, clients).tick()]); }
  finally { await other.$disconnect(); }
  expect(visible(8)).toHaveLength(1);
  expect(writes - before).toBe(1);
});

it('backs off, stops after three failures, preserves intended revision and supports an operator retry', async () => {
  const run = await dispatch(9);
  await finalize(run);
  failRemote = { status: 429, response: { headers: { 'retry-after': '120', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 180) } } };
  try {
    const before = Date.now();
    await publisher.tick();
    const first = await intent(9);
    expect(first.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 180000);
    expect(first.diagnostics).toMatchObject({ status: 429, attempt: 1 });
    await publisher.tick(); expect((await intent(9)).attempts).toBe(1);
    for (let attempt = 0; attempt < 2; attempt++) { await due(9); await publisher.tick(); }
    expect(await intent(9)).toMatchObject({ state: 'failed', attempts: 3, runId: run.id });
    await due(9); await publisher.tick();
    expect((await intent(9)).attempts).toBe(3);
    expect((await pointer(9))?.latestRunId).toBe(run.id);
    expect((await db.reviewRun.findUniqueOrThrow({ where: { id: run.id } })).headSha).toBe(run.headSha);
  } finally { failRemote = undefined; }
  await retryPublication(db, '200', 9); await publisher.tick();
  expect(await intent(9)).toMatchObject({ state: 'published', attempts: 1 });
  expect(visible(9)).toHaveLength(1);
});

it('preserves diagnostics and exhausts retries when the publication client cannot be configured', async () => {
  const run = await dispatch(12);
  await finalize(run);
  const broken = createPublisher(db, () => { throw new Error('Private credential detail'); });
  for (let attempt = 0; attempt < 3; attempt++) { await due(12); await broken.tick(); }
  const failed = await intent(12);
  expect(failed).toMatchObject({ runId: run.id, state: 'failed', attempts: 3 });
  expect(JSON.stringify(failed)).not.toContain('Private credential detail');
});

it('cancels publication on revocation and fences an old publisher after re-selection', async () => {
  const run = await dispatch(10);
  await finalize(run);
  const before = writes;
  const selected = gate(), release = gate();
  const delayed = db.$extends({ query: { reviewPublication: { async findMany({ args, query }) {
    const rows = await query(args); selected.release(); await release.promise; return rows;
  } } } });
  const stalePublisher = createPublisher(delayed as unknown as PrismaClient, clients).tick();
  try {
    await selected.promise;
    await send('installation_repositories', { action: 'removed', installation: { id: 100 }, repositories_removed: [{ id: 200 }] });
    await publisher.tick();
    expect(writes).toBe(before);
    expect(await intent(10)).toMatchObject({ state: 'cancelled' });
    expect((await pointer(10))?.eligible).toBe(false);
    await expect(retryPublication(db, '200', 10)).rejects.toThrow('revoked');
    await send('installation_repositories', { action: 'added', installation: { id: 100 }, repositories_added: [{ id: 200, name: 'repo', full_name: 'owner/repo' }] });
    const selectedAgain = await dispatch(10);
    expect(selectedAgain.id).toBe(run.id);
    release.release(); await stalePublisher;
    expect(await intent(10)).toMatchObject({ state: 'pending', runId: run.id });
    await publisher.tick();
    expect(await intent(10)).toMatchObject({ state: 'published' });
    expect(visible(10)).toHaveLength(1);
  } finally { release.release(); await stalePublisher; }
});
