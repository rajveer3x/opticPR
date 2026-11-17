import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '../packages/database/dist/index.js';
import { reportSchema } from '../packages/contracts/dist/index.js';
import { FixtureRepositoryAdapter } from '../packages/repository/dist/index.js';
import { createQueue, repositoryScope, waitForReport } from '../packages/runtime/dist/index.js';
import { createApp } from '../apps/api/dist/app.js';
import { createWorker } from '../apps/worker/dist/worker.js';
import { createDispatcher } from '../apps/worker/dist/dispatcher.js';
import { createPublisher } from '../apps/worker/dist/publication.js';
import { scanSemgrep } from '../apps/worker/dist/semgrep.js';
import { backup, postgres, restore } from './backup.mjs';

const id = randomUUID().replaceAll('-', ''), schema = `recovery_${id}`, database = `opticpr_restore_${id}`;
const output = resolve(process.argv[2] ?? `output/recovery-${id}.json`);
const url = new URL(process.env.DATABASE_URL); url.searchParams.set('schema', schema);
const admin = new PrismaClient(), sourceDb = new PrismaClient({ datasourceUrl: url.toString() });
const restoredUrl = new URL(url); restoredUrl.pathname = `/${database}`;
const restoredDb = new PrismaClient({ datasourceUrl: restoredUrl.toString() });
const temp = await mkdtemp(join(tmpdir(), 'opticpr-recovery-'));
const fixture = await FixtureRepositoryAdapter.open();
const timeline = JSON.parse(await readFile(new URL('../fixtures/pagination/history.json', import.meta.url), 'utf8'));
const events = [], remote = [], threads = [];
const secret = randomUUID();
let headSha = timeline.scenarios.original, compareGate, scannerSkipped = false, remoteCreates = 0;
const clients = (scope, assertAccess) => ({
  async pullRequest(number) { await assertAccess(); return { number, repositoryId: scope.repositoryId, baseSha: timeline.baseSha, headSha, state: 'open', draft: false, title: 'Synthetic recovery PR' }; },
  async compare(base, head) { await assertAccess(); await compareGate?.(head); return fixture.changedFiles(base, head); },
  async file(sha, path) { await assertAccess(); return fixture.fileAt(sha, path); },
  async comments() { await assertAccess(); return structuredClone(remote); },
  async createComment(number, body) { await assertAccess(); remoteCreates++; const id = 'mock-summary-1'; remote.push({ id, body, appOwned: true }); return id; },
  async updateComment(id, body) { await assertAccess(); remote.find(comment => comment.id === id).body = body; },
  async reviewComments() { await assertAccess(); return structuredClone(threads); },
  async createReview(number, originalCommitId, comment) { await assertAccess(); const id = `mock-inline-${threads.length+1}`; threads.push({ id, reviewId: id, ...comment, originalCommitId, originalLine: comment.line, reply: false, appOwned: true }); return id; },
});
const services = { scanner: files => scannerSkipped ? Promise.resolve({ matches: [], scanned: [], errors: 0 }) : scanSemgrep(files),
  inference: async () => { throw new Error('Deliberate model outage'); } };
const originalModel = process.env.MODEL_ENRICHMENT_ENABLED; process.env.MODEL_ENRICHMENT_ENABLED = '1';
let db = sourceDb, queue = createQueue(schema), worker, second, dispatcher, publisher, server, origin, release;
const event = (name, detail) => { const item = { at: new Date().toISOString(), name, ...detail }; events.push(item); console.log(JSON.stringify(item)); };
async function httpStart() {
  server = createApp(db, { webhookSecret: secret, allowFixtureInspection: true }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
}
async function send(event, payload, delivery = randomUUID()) {
  const body = JSON.stringify(payload);
  const response = await fetch(`${origin}/webhooks/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-delivery': delivery, 'x-github-event': event,
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body });
  assert.ok([200, 202].includes(response.status)); return delivery;
}
const push = () => ({ action: 'synchronize', installation: { id: 100 }, repository: { id: 200, name: 'synthetic', owner: { login: 'fixture' } }, number: 1, pull_request: { number: 1, state: 'open', draft: false } });
async function dispatch() {
  await send('pull_request', push()); await dispatcher.tick();
  return db.reviewRun.findFirstOrThrow({ where: { headSha }, orderBy: { createdAt: 'desc' } });
}
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, release: resolve }; };
try {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const directory = new URL('../packages/database/prisma/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d/.test(name)).sort()) {
    for (const statement of (await readFile(new URL(`${name}/migration.sql`, directory), 'utf8')).split(';').map(s => s.trim()).filter(Boolean)) await sourceDb.$executeRawUnsafe(statement);
  }
  await httpStart();
  await send('installation', { action: 'created', installation: { id: 100 }, repositories: [{ id: 200, name: 'synthetic', full_name: 'fixture/synthetic' }] });
  dispatcher = createDispatcher(db, queue, clients); publisher = createPublisher(db, clients);
  worker = createWorker(db, schema, clients, services); await worker.waitUntilReady();
  const original = await dispatch();
  const report = reportSchema.parse((await waitForReport(db, original.id)).report);
  assert.equal(report.enrichment.status, 'failed'); assert.equal(report.findings.length, 1);
  await publisher.tick(); assert.equal(remote.length, 1); assert.ok(remote[0].body.includes(original.headSha));
  event('static-alert-survived-model-failure', { runId: original.id, baseSha: original.baseSha, headSha: original.headSha, findings: report.findings.length, model: report.enrichment.status, remoteCommentId: remote[0].id });
  const entered = gate(), blocked = gate(); release = blocked.release;
  headSha = timeline.scenarios.moved;
  compareGate = async head => { if (head === timeline.scenarios.moved) { entered.release(); await blocked.promise; } };
  const unfinished = await dispatch(); await entered.promise;
  const backupInfo = await backup(join(temp, 'database.dump'), schema);
  await restore(join(temp, 'database.dump'), database);
  assert.equal((await restoredDb.reviewRun.findUniqueOrThrow({ where: { id: unfinished.id } })).state, 'running');
  event('backup-restored', { ...backupInfo, unfinishedRunId: unfinished.id, restoredState: 'running', restoredPointer: (await restoredDb.pullRequest.findFirstOrThrow()).latestRunId });
  // Finish the source process only after the backup is immutable. Its publisher
  // remains stopped; all following assertions use the restored database.
  release(); await waitForReport(sourceDb, unfinished.id); await worker.close(); worker = undefined;
  await dispatcher.close(); await publisher.close(); await new Promise(resolve => server.close(resolve)); server = undefined;
  await queue.obliterate({ force: true }); await queue.close();
  db = restoredDb; queue = createQueue(`${schema}_restored`);
  dispatcher = createDispatcher(db, queue, clients); publisher = createPublisher(db, clients); await httpStart();
  const restoredEntered = gate(), restoredBlocked = gate(); release = restoredBlocked.release;
  compareGate = async head => { if (head === timeline.scenarios.moved) { restoredEntered.release(); await restoredBlocked.promise; } };
  worker = createWorker(db, `${schema}_restored`, clients, services); await worker.waitUntilReady();
  await dispatcher.tick(); await restoredEntered.promise;
  event('unfinished-work-reconciled', { runId: unfinished.id, logicalKey: unfinished.logicalKey, queueLost: true, resumedState: (await db.reviewRun.findUniqueOrThrow({ where: { id: unfinished.id } })).state });
  headSha = timeline.scenarios.fixed;
  const fix = await dispatch(); second = createWorker(db, `${schema}_restored`, clients, services); await second.waitUntilReady();
  const fixed = reportSchema.parse((await waitForReport(db, fix.id)).report); assert.equal(fixed.findings.length, 0);
  await publisher.tick(); assert.equal((await db.pullRequest.findFirstOrThrow()).latestRunId, fix.id);
  release(); await waitForReport(db, unfinished.id); await publisher.tick();
  assert.equal((await db.pullRequest.findFirstOrThrow()).latestRunId, fix.id); assert.ok(remote[0].body.includes(fix.headSha)); assert.ok(!remote[0].body.includes(unfinished.headSha));
  event('fix-won-over-late-worker', { lateRunId: unfinished.id, lateBaseSha: unfinished.baseSha, lateHeadSha: unfinished.headSha, fixRunId: fix.id, baseSha: fix.baseSha, headSha: fix.headSha, latestRunId: (await db.pullRequest.findFirstOrThrow()).latestRunId, remoteCommentId: remote[0].id });
  const delivery = await send('pull_request', push()); await dispatcher.tick(); await publisher.tick();
  await send('pull_request', push(), delivery); await dispatcher.tick(); await publisher.tick();
  assert.equal(await db.webhookReceipt.count({ where: { id: delivery } }), 1);
  assert.equal(remote.length, 1); assert.equal(remoteCreates, 1); assert.equal((await db.pullRequest.findFirstOrThrow()).commentId, remote[0].id);
  event('redelivery-preserved-one-summary', { deliveryId: delivery, latestRunId: fix.id, remoteCommentId: remote[0].id, summaryCount: remote.length, remoteCreates });
  scannerSkipped = true; headSha = timeline.scenarios.renamed;
  const incomplete = await dispatch();
  const partial = reportSchema.parse((await waitForReport(db, incomplete.id)).report);
  assert.equal(partial.recheck.completed, true); // scanner returned successfully but omitted the affected file
  assert.equal(partial.coverage.status, 'partial');
  assert.equal(partial.history.findings.filter(item => item.state === 'cleared_by_recheck').length, 0);
  event('incomplete-scan-retained-evidence', { runId: incomplete.id, headSha, skippedFiles: partial.coverage.skippedFiles, falseClearances: 0, states: partial.history.findings.map(item => item.state) });
  await mkdir(new URL('../output/', import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify({ version: 1, measuredAt: new Date().toISOString(), environment: 'Real PostgreSQL dump/restore and Redis/BullMQ; digest-pinned Semgrep; synthetic bundled source; mocked GitHub remote IDs; deliberately failing model.', events, finalSummaryBody: remote[0].body }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ evidence: output }));
} finally {
  release?.(); compareGate = undefined;
  await second?.close(); await worker?.close(); await dispatcher?.close(); await publisher?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await queue.obliterate({ force: true }); await queue.close(); await fixture.close();
  await sourceDb.$disconnect(); await restoredDb.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.$disconnect();
  await postgres('dropdb', ['--if-exists', database]); await rm(temp, { recursive: true, force: true });
  if (originalModel === undefined) delete process.env.MODEL_ENRICHMENT_ENABLED; else process.env.MODEL_ENRICHMENT_ENABLED = originalModel;
}
