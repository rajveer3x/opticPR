import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixtureConfig, reportSchema } from '../packages/contracts/src/index.js';
import { PrismaClient } from '../packages/database/src/index.js';
import { FixtureRepositoryAdapter } from '../packages/repository/src/index.js';
import { createQueue, requireReady, scheduleRun, waitForReport, type Worker } from '../packages/runtime/src/index.js';
import { createWorker } from '../apps/worker/src/worker.js';
import { createApp } from '../apps/api/src/app.js';

const namespace = `opticpr_test_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(process.env.DATABASE_URL!);
databaseUrl.searchParams.set('schema', namespace);
const admin = new PrismaClient();
const db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
let queue: ReturnType<typeof createQueue>;
let worker: Worker;
let adapter: FixtureRepositoryAdapter;
let server: Server;
let origin: string;

beforeAll(async () => {
  // Isolate storage and queue so every invocation exercises first insertion.
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
  const migrations = new URL('../packages/database/prisma/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => /^\d/.test(name)).sort()) {
    const migration = await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8');
    for (const statement of migration.split(';').map(part => part.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  }
  await requireReady(db);
  queue = createQueue(namespace);
  worker = createWorker(db, namespace);
  await worker.waitUntilReady();
  adapter = await FixtureRepositoryAdapter.open();
  server = createApp(db, { allowFixtureInspection: true }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  origin = `http://127.0.0.1:${address.port}`;
}, 30000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await worker?.close();
  await queue?.obliterate({ force: true }); await queue?.close();
  await adapter?.close(); await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await admin.$disconnect();
});

it('migrated services persist one run across concurrent replay and serve the stored report by ID', async () => {
  const input = await adapter.revisions();
  const runs = await Promise.all([
    scheduleRun(db, queue, input, fixtureConfig), scheduleRun(db, queue, input, fixtureConfig),
  ]);
  expect(runs[0]!.id).toBe(runs[1]!.id);
  const stored = await waitForReport(db, runs[0]!.id);
  expect(await db.reviewRun.count({ where: { logicalKey: stored.logicalKey } })).toBe(1);
  const again = await scheduleRun(db, queue, input, fixtureConfig);
  expect(again.id).toBe(stored.id);
  expect(again.report).toEqual(stored.report);
  const response = await fetch(`${origin}/api/runs/${stored.id}`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.baseSha).toBe(input.baseSha);
  expect(body.headSha).toBe(input.headSha);
  const report = reportSchema.parse(body.report);
  expect(report.runId).toBe(stored.id);
  expect(report.configurationDigest).toBe(stored.configurationDigest);
  expect(report.coverage.changedFiles).toEqual(['src/paginate.ts']);
  expect(report.coverage.analyzedFiles).toEqual(['src/paginate.ts']);
  expect(report.coverage.skippedFiles).toEqual([]);
  expect(report.stages.every(stage => stage.source === 'fixture')).toBe(true);
  expect(report.stages.filter(stage => stage.status === 'completed').map(stage => stage.name)).toEqual(['repository', 'analysis']);
  expect(report.findings[0]!.evidence.revision).toBe(input.headSha);
  expect(report.findings[0]!.evidence.startLine).toBe(3);
}, 30000);

it('recovers a durable queued run whose queue entry was lost', async () => {
  // Wait for BullMQ to acknowledge completion, then simulate a queue restart
  // after PostgreSQL persisted work but before it was successfully enqueued.
  const original = await adapter.revisions();
  const existing = await scheduleRun(db, queue, original, fixtureConfig);
  await waitForReport(db, existing.id);
  await worker.pause();
  await db.reviewRun.update({ where: { id: existing.id }, data: { state: 'queued', report: null, completedAt: null } });
  await scheduleRun(db, queue, original, fixtureConfig);
  await worker.resume();
  const recovered = await waitForReport(db, existing.id);
  expect(recovered.state).toBe('completed');
  expect(reportSchema.parse(recovered.report).input).toEqual(original);
}, 30000);

it('reports dependency readiness and distinguishes invalid and absent run IDs', async () => {
  const ready = await fetch(`${origin}/health/ready`);
  expect(ready.status).toBe(200);
  expect(await ready.json()).toEqual({ ready: true, dependencies: { postgresql: 'up', redis: 'up' } });
  expect((await fetch(`${origin}/health/live`)).status).toBe(200);
  expect((await fetch(`${origin}/api/runs/bad-id`)).status).toBe(400);
  expect((await fetch(`${origin}/api/runs/${randomUUID()}`)).status).toBe(404);
});
