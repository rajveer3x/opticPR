import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { githubConfig, reportSchema, type GitHubScope, type ReviewInput } from '../packages/contracts/src/index.js';
import { Prisma, PrismaClient } from '../packages/database/src/index.js';
import { FixtureRepositoryAdapter, type GitHubPublicationClientFactory, type ReviewComment } from '../packages/repository/src/index.js';
import { createQueue, enqueueRun, repositoryScope, runIdentity, waitForReport, type Worker } from '../packages/runtime/src/index.js';
import { createWorker } from '../apps/worker/src/worker.js';
import { createPublisher } from '../apps/worker/src/publication.js';
import { lockPullRequest, observeLiveTarget } from '../apps/worker/src/current-review.js';
import { scanSemgrep, type StaticScanner } from '../apps/worker/src/semgrep.js';
import { withInferenceSlot, type InferenceClient } from '../apps/worker/src/inference.js';
import { analyzeLocal } from '../apps/worker/src/local-analysis.js';
import { snapshotFindingHistory } from '../apps/worker/src/finding-history.js';
import { missingUserFixture, routePath, usersPath } from './cross-file-fixture.js';

const namespace = `analysis_test_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('schema', namespace);
const admin = new PrismaClient();
const db = new PrismaClient({ datasourceUrl: url.toString() });
const other = new PrismaClient({ datasourceUrl: url.toString() });
let scope: GitHubScope;
let queue: ReturnType<typeof createQueue>;
let worker: Worker | undefined;
let second: Worker | undefined;
let mode: 'malformed' | 'timeout' | 'wrong-excerpt' | 'valid' | 'transport-retry' = 'malformed';
let scannerCalls = 0, modelCalls = 0, active = 0, peak = 0;
let failFinalization = false;
const source = 'export function run(input: string) {\n  eval(input);\n}\n';
const patch = '@@ -1,2 +1,3 @@\n export function run(input: string) {\n+  eval(input);\n }';
const comments = new Map<number, { id: string; body: string; appOwned: boolean }[]>();
const reviewComments = new Map<number, ReviewComment[]>();
const clients: GitHubPublicationClientFactory = (scope, access) => ({
  async pullRequest(number) {
    await access();
    // Inject a transient finalization failure after inference, forcing BullMQ to
    // retry the same run and reuse the already committed static checkpoint.
    if (failFinalization) { failFinalization = false; throw new Error('transient finalization'); }
    return { number, repositoryId: scope.repositoryId, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), state: 'open', draft: false };
  },
  async compare() { await access(); return [{ path: 'src/run.ts', hunk: patch, status: 'modified' }]; },
  async file() { await access(); return source; },
  async comments(number) { await access(); return comments.get(number) ?? []; },
  async createComment(number, body) { await access(); const id = String(number); comments.set(number, [{ id, body, appOwned: true }]); return id; },
  async updateComment(id, body) { await access(); comments.get(Number(id))![0]!.body = body; },
  async reviewComments(number) { await access(); return reviewComments.get(number) ?? []; },
  async createReview(number, headSha, comment) {
    await access();
    const id = String(number);
    reviewComments.set(number, [{ ...comment, id, reviewId: id, appOwned: true, originalCommitId: headSha, originalLine: comment.line, reply: false }]);
    return id;
  },
});
const scanner: StaticScanner = async files => {
  scannerCalls++;
  return { errors: 0, scanned: files.map(file => file.path), matches: files.map(file => ({ path: file.path,
    ruleId: 'opticpr.dynamic-eval', severity: 'high', startLine: 2, endLine: 2, message: 'Dynamic evaluation may execute untrusted input.' })) };
};
const inference: InferenceClient = async ({ signal, runId }) => {
  active++; peak = Math.max(peak, active); modelCalls++;
  try {
    // This query runs on a separate connection before returning any model output.
    const run = await other.reviewRun.findUniqueOrThrow({ where: { id: runId }, include: { observations: true } });
    expect(run.state).toBe('running');
    expect(run.staticCompletedAt).toBeInstanceOf(Date);
    expect(run.staticCheckpoint).toBeTruthy();
    expect(run.observations).toHaveLength(1);
    if (mode === 'timeout') await new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    if (mode === 'malformed') return '{not json';
    if (mode === 'transport-retry') failFinalization = true;
    if (mode === 'wrong-excerpt') return JSON.stringify({ candidates: [{ observationId: null, ruleId: 'eval', severity: 'high', title: 'Eval', impact: 'Injection', verification: 'Test input',
      revision: 'b'.repeat(40), path: 'src/run.ts', startLine: 2, endLine: 2, excerpt: '  eval(incorrect);' }] });
    return '{"candidates":[]}';
  } finally { active--; }
};
async function prepare(number: number) {
  return db.$transaction(async tx => {
    await lockPullRequest(tx, scope, number);
    return (await observeLiveTarget(tx, scope, number, clients(scope, async () => {})))!.run;
  });
}
async function start(deadlineMs = 2000) {
  worker = createWorker(db, namespace, clients, { scanner, inference, deadlineMs });
  await worker.waitUntilReady();
}
async function finishWorker() { await second?.close(); second = undefined; await worker?.close(); worker = undefined; }
beforeAll(async () => {
  process.env.MODEL_ENRICHMENT_ENABLED = '1';
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
  const directory = new URL('../packages/database/prisma/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d/.test(name)).sort()) {
    for (const statement of (await readFile(new URL(`${name}/migration.sql`, directory), 'utf8')).split(';').map(value => value.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  }
  await db.gitHubInstallation.create({ data: { id: '100' } });
  await db.gitHubRepository.create({ data: { id: '200', installationId: '100', owner: 'owner', name: 'repo' } });
  scope = await repositoryScope(db, '100', '200');
  queue = createQueue(namespace); await queue.waitUntilReady();
}, 30000);
afterAll(async () => {
  delete process.env.MODEL_ENRICHMENT_ENABLED;
  await finishWorker(); await queue?.obliterate({ force: true }); await queue?.close(); await db.$disconnect(); await other.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin.$disconnect();
}, 30000);

it.each(['malformed', 'timeout'] as const)('commits static evidence before %s inference and publishes the same alert after retry', async failure => {
  mode = failure;
  const run = await prepare(failure === 'malformed' ? 1 : 2);
  await start(failure === 'timeout' ? 200 : 2000);
  try {
    await enqueueRun(queue, run);
    const first = reportSchema.parse((await waitForReport(db, run.id)).report);
    expect(first).toMatchObject({ coverage: { status: 'partial' }, enrichment: { status: 'failed' } });
    expect(first.findings).toHaveLength(1);
    expect(await db.runObservation.count({ where: { runId: run.id } })).toBe(1);
    await createPublisher(db, clients).tick();
    expect(comments.get(run.pullRequestNumber)?.[0]?.body).toContain('Dynamic evaluation');
    expect(comments.get(run.pullRequestNumber)?.[0]?.body).toContain('Excerpt:');
    expect(comments.get(run.pullRequestNumber)?.[0]?.body).toContain('**partial**');
    await worker!.pause();
    const calls = scannerCalls;
    await db.reviewRun.update({ where: { id: run.id }, data: { state: 'queued', report: Prisma.DbNull } });
    await enqueueRun(queue, run); await worker!.resume();
    const retried = reportSchema.parse((await waitForReport(db, run.id)).report);
    expect(retried.findings).toEqual(first.findings);
    expect(scannerCalls).toBe(calls);
    expect(await db.runObservation.count({ where: { runId: run.id } })).toBe(1);
  } finally { await finishWorker(); }
}, 15000);

it('rejects a schema-valid candidate with an incorrect excerpt and counts it', async () => {
  mode = 'wrong-excerpt';
  const run = await prepare(3); await start();
  try {
    await enqueueRun(queue, run);
    const report = reportSchema.parse((await waitForReport(db, run.id)).report);
    expect(report.enrichment).toMatchObject({ status: 'partial', rejected: 1, accepted: 0 });
    expect(report.findings).toHaveLength(1);
    expect(await db.runEnrichment.count({ where: { runId: run.id } })).toBe(0);
  } finally { await finishWorker(); }
});

it('shares one inference slot between two workers, concurrent runs and actual BullMQ retries', async () => {
  // Force just the first model call to cause a downstream retry.
  let first = true;
  const retrying: InferenceClient = async request => {
    const result = await inference(request);
    if (first) { first = false; failFinalization = true; }
    return result;
  };
  mode = 'valid'; active = 0; peak = 0;
  const initialCalls = modelCalls;
  const a = await prepare(4), b = await prepare(5);
  worker = createWorker(db, namespace, clients, { scanner, inference: retrying });
  second = createWorker(other, namespace, clients, { scanner, inference: retrying });
  await Promise.all([worker.waitUntilReady(), second.waitUntilReady()]);
  try {
    await Promise.all([enqueueRun(queue, a), enqueueRun(queue, b)]);
    await Promise.all([waitForReport(db, a.id), waitForReport(db, b.id)]);
    expect(peak).toBe(1); expect(modelCalls - initialCalls).toBeGreaterThanOrEqual(3);
    expect(await db.runObservation.count({ where: { runId: { in: [a.id, b.id] } } })).toBe(2);
  } finally { await finishWorker(); }
}, 15000);

it('counts time waiting for the host slot toward the model deadline and releases after errors', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { entered = resolve; });
  const holding = withInferenceSlot(db, new AbortController().signal, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
  await gate;
  try {
    await expect(withInferenceSlot(other, AbortSignal.timeout(40), async () => { throw new Error('must not invoke'); })).rejects.toThrow();
  } finally { release(); await holding; }
  await expect(withInferenceSlot(other, AbortSignal.timeout(1000), async () => 42)).resolves.toBe(42);
});

it('runs the actual pinned Semgrep rules in the read-only network-disabled container', async () => {
  const adapter = await FixtureRepositoryAdapter.open();
  try {
    const input = await adapter.revisions();
    const result = await scanSemgrep([{ path: 'src/paginate.ts', source: await adapter.fileAt(input.headSha, 'src/paginate.ts') }, { path: 'src/eval.ts', source }]);
    expect(result.errors).toBe(0);
    expect(result.scanned.sort()).toEqual(['src/eval.ts', 'src/paginate.ts']);
    expect(result.matches).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'opticpr.dynamic-eval', startLine: 2 }), expect.objectContaining({ ruleId: 'opticpr.slice-exclusive-boundary', startLine: 3 })]));
  } finally { await adapter.close(); }
}, 60000);

it('records file and changed-line limits and filters excluded source before scanning', async () => {
  const input = { source: 'github' as const, repositoryId: '200', pullRequestNumber: 6, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
  const identity = runIdentity(input, githubConfig);
  const run = await db.reviewRun.create({ data: { ...input, ...identity, configuration: githubConfig, state: 'running' } });
  const changes = [
    { path: 'secrets.ts', hunk: patch }, { path: 'src/generated.ts', hunk: patch },
    { path: 'src/huge.ts', hunk: `@@ -0,0 +1,801 @@\n${'+x\n'.repeat(801)}` },
    ...Array.from({ length: 21 }, (_, i) => ({ path: `src/${i}.ts`, hunk: patch })),
  ];
  const report = await analyzeLocal(db, { async revisions() { return input; }, async changedFiles() { return changes; }, async fileAt(sha, path) { return path === 'src/generated.ts' ? '// @generated\n' + source : source; }, async close() {} }, input, githubConfig, { runId: run.id, ...identity }, { scanner, inference: async () => '{"candidates":[]}' });
  expect(report.coverage.analyzedFiles).toHaveLength(20);
  expect(report.coverage.skippedFiles).toEqual(expect.arrayContaining([
    { path: 'secrets.ts', reason: 'secret file' }, { path: 'src/generated.ts', reason: 'generated code' },
    { path: 'src/huge.ts', reason: '800-changed-line budget' }, { path: 'src/20.ts', reason: '20-file budget' },
  ]));
  expect(report.coverage.status).toBe('partial');
});


it('keeps model inference opt-in while reporting complete static coverage', async () => {
  const input = { source: 'github' as const, repositoryId: '200', pullRequestNumber: 99, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
  const identity = runIdentity(input, githubConfig);
  const run = await db.reviewRun.create({ data: { ...input, ...identity, configuration: githubConfig, state: 'running' } });
  let called = false;
  const report = await analyzeLocal(db, { async revisions() { return input; }, async changedFiles() { return [{ path: 'src/run.ts', hunk: patch }]; }, async fileAt() { return source; }, async close() {} }, input, githubConfig, { runId: run.id, ...identity }, { scanner, inference: async () => { called = true; throw new Error('Must not call inference by default'); } });
  expect(called).toBe(false);
  expect(report.findings).toHaveLength(1);
  expect(report.coverage.status).toBe('complete');
  expect(report.enrichment).toMatchObject({ status: 'skipped', accepted: 0, rejected: 0 });
});

it.each(['return', 'handler'] as const)('preserves a prior cross-file finding during incomplete scans and clears it after the %s fix', async fixed => {
  const input: ReviewInput = { source: 'github', repositoryId: '200', pullRequestNumber: fixed === 'return' ? 90 : 91, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
  async function check(head: string, options?: Parameters<typeof missingUserFixture>[1]) {
    const revisions = { ...input, headSha: head.repeat(40) };
    const identity = runIdentity(revisions, githubConfig);
    const run = await db.reviewRun.create({ data: { ...revisions, ...identity, configuration: githubConfig, state: 'running' } });
    const { adapter } = missingUserFixture(revisions, options);
    const report = await analyzeLocal(db, adapter, revisions, githubConfig, { ...identity, runId: run.id }, {
      scanner: async files => ({ scanned: files.map(file => file.path), errors: 0, matches: [] }),
    });
    const observations = await db.runObservation.findMany({ where: { runId: run.id } });
    expect(observations.map(row => row.finding)).toEqual(report.findings);
    const checkpoint = await db.reviewRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(checkpoint.staticCheckpoint).toMatchObject({ report: { crossFileRecheck: report.crossFileRecheck } });
    return db.$transaction(tx => snapshotFindingHistory(tx, report));
  }

  const flagged = await check('b');
  expect(flagged.coverage.status).toBe('complete');
  expect(flagged.findings).toHaveLength(1);
  expect(flagged.stages.find(stage => stage.name === 'cross-file')).toMatchObject({ status: 'completed' });
  const finding = flagged.findings[0]!;

  const unavailable = await check('c', { fixed, callerUnavailable: true });
  expect(unavailable.coverage).toMatchObject({ status: 'partial', skippedFiles: expect.arrayContaining([{ path: routePath, reason: 'TypeScript head source unavailable' }]) });
  expect(unavailable.findings).toHaveLength(0);
  expect(unavailable.history?.findings).toMatchObject([{ state: 'needs_verification', lastObservation: finding }]);

  const extra = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`src/extra${i}.ts`, 'export {};']));
  const budget = await check('d', { fixed, extra });
  expect(budget.coverage.status).toBe('partial');
  expect(budget.coverage.skippedFiles).toContainEqual({ path: '.', reason: expect.stringContaining('caller budget exhausted') });
  expect(budget.crossFileRecheck).toMatchObject({ completed: false, callees: expect.arrayContaining([usersPath]), callers: expect.arrayContaining([routePath]) });
  expect(budget.history?.findings).toMatchObject([{ state: 'needs_verification', lastObservation: finding }]);

  const resolved = await check('e', { fixed });
  expect(resolved.coverage.status).toBe('complete');
  expect(resolved.findings).toHaveLength(0);
  expect(resolved.history?.findings).toMatchObject([{ state: 'cleared_by_recheck', findingId: finding.id, lastObservation: finding }]);
  if (fixed === 'return') expect(resolved.comparison).toEqual([]);
});
