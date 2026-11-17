import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import type { Server } from 'node:http';
import ts from 'typescript';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { githubConfig, reportSchema, type Report } from '../packages/contracts/src/index.js';
import { PrismaClient } from '../packages/database/src/index.js';
import { FixtureRepositoryAdapter } from '../packages/repository/src/index.js';
import { createQueue, scheduleRun, waitForReport, type Worker } from '../packages/runtime/src/index.js';
import { createWorker } from '../apps/worker/src/worker.js';
import { createApp } from '../apps/api/src/app.js';
import { appendFindingDecision, snapshotFindingHistory } from '../apps/worker/src/finding-history.js';
import { scanSemgrep } from '../apps/worker/src/semgrep.js';

const namespace = `history_test_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('schema', namespace);
const admin = new PrismaClient(), db = new PrismaClient({ datasourceUrl: url.toString() });
const configuration = { ...githubConfig, adapter: 'pagination-bundle-v1' as const };
let queue: ReturnType<typeof createQueue>, worker: Worker, server: Server, origin: string;
let timeline: { baseSha: string; scenarios: Record<string, string> };
let scanMode: 'real' | 'skip' = 'real';
let modelMode: 'empty' | 'enrich' | 'novel' = 'empty';
beforeAll(async () => {
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
  const migrations = new URL('../packages/database/prisma/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => /^\d/.test(name)).sort()) {
    for (const statement of (await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8')).split(';').map(value => value.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  }
  timeline = JSON.parse(await readFile(new URL('../fixtures/pagination/history.json', import.meta.url), 'utf8'));
  queue = createQueue(namespace); await queue.waitUntilReady();
  worker = createWorker(db, namespace, undefined, {
    scanner: async files => scanMode === 'skip' ? { errors: 0, matches: [], scanned: [] } : scanSemgrep(files),
    inference: async ({ runId }) => {
      if (modelMode === 'empty') return '{"candidates":[]}';
      const run = await db.reviewRun.findUniqueOrThrow({ where: { id: runId } });
      const report = (run.staticCheckpoint as { report: Report }).report;
      const finding = report.findings[0]!;
      return JSON.stringify({ candidates: [{ observationId: modelMode === 'enrich' ? finding.id : null,
        ruleId: modelMode === 'enrich' ? finding.ruleId : 'independent-model-class', title: 'Boundary evidence', severity: 'medium', impact: 'Final item omitted', verification: 'Exercise boundary inputs',
        ...finding.evidence, hunk: undefined, revision: report.input.headSha }] });
    },
  });
  await worker.waitUntilReady();
  server = createApp(db, { allowFixtureInspection: true }).listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No HTTP address');
  origin = `http://127.0.0.1:${address.port}`;
}, 30000);
afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  await worker?.close(); await queue?.obliterate({ force: true }); await queue?.close(); await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin.$disconnect();
}, 30000);
async function review(scenario: string, number: number, config = configuration) {
  const input = { source: 'fixture' as const, repositoryId: 'fixture/pagination', pullRequestNumber: number, baseSha: timeline.baseSha, headSha: timeline.scenarios[scenario]! };
  const run = await scheduleRun(db, queue, input, config);
  return reportSchema.parse((await waitForReport(db, run.id, 60000)).report);
}
async function inspect(report: Report) {
  const response = await fetch(`${origin}/api/runs/${report.runId}`); expect(response.status).toBe(200);
  const body = await response.json(); expect(body.report).toEqual(report); return body;
}

it('executes the trusted synthetic boundary example and checks both Git revisions', async () => {
  const adapter = await FixtureRepositoryAdapter.open();
  try {
    const input = await adapter.revisions();
    for (const [sha, full, single] of [[input.baseSha, [1, 2, 3], [1]], [input.headSha, [1, 2], []]] as const) {
      const source = await adapter.fileAt(sha, 'src/paginate.ts');
      // Only this checked-in synthetic fixture is executed, never reviewed PR code.
      const javascript = ts.transpileModule(source.replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      expect(Array.from(runInNewContext(`${javascript}\npaginate([1,2,3], 1, 3)`))).toEqual(full);
      expect(Array.from(runInNewContext(`${javascript}\npaginate([1,2,3], 1, 1)`))).toEqual(single);
    }
  } finally { await adapter.close(); }
});

it('persists exact original evidence, groups sources, carries a dismissal through a move and clears a real fix', async () => {
  modelMode = 'enrich';
  const original = await review('original', 1); modelMode = 'empty';
  expect(original.findings).toHaveLength(1);
  expect(original.findings[0]!.citations?.map(item => item.kind)).toEqual(['static', 'model']);
  const findingId = original.findings[0]!.id;
  expect(original.history!.findings[0]!.state).toBe('new');
  expect(original.findings[0]!.evidence).toMatchObject({ revision: timeline.scenarios.original, path: 'src/paginate.ts', startLine: 3, excerpt: '  const end = start + pageSize - 1;\n  return items.slice(start, end);' });
  const input = { id: randomUUID(), runId: original.runId, findingId, action: 'dismiss', actor: 'raj', reason: 'Accepted in this synthetic example' };
  const decision = await appendFindingDecision(db, input);
  expect((await appendFindingDecision(db, input)).id).toBe(decision.id);
  await expect(appendFindingDecision(db, { ...input, reason: 'changed' })).rejects.toThrow('conflict');
  const moved = await review('moved', 1);
  expect(moved.findings[0]).toMatchObject({ id: findingId, evidence: { startLine: 5 } });
  expect(moved.history!.findings[0]).toMatchObject({ state: 'still_present', decision: { actor: 'raj', reason: input.reason } });
  expect((await inspect(original)).decisions).toHaveLength(1); await inspect(moved);
  const fixed = await review('fixed', 1);
  expect(fixed.findings).toEqual([]);
  expect(fixed.coverage.changedFiles).toEqual([]);
  expect(fixed.recheck).toMatchObject({ completed: true, files: ['src/paginate.ts'] });
  expect(fixed.history!.findings[0]).toMatchObject({ findingId, state: 'cleared_by_recheck', lastObservedRunId: moved.runId, lastObservation: { evidence: { startLine: 5 } } });
  await inspect(original); await inspect(moved); await inspect(fixed);
  const stored = await db.findingSnapshot.findUniqueOrThrow({ where: { runId: original.runId } });
  expect(stored.report).toEqual(original);
  const reopened = await appendFindingDecision(db, { ...input, id: randomUUID(), runId: moved.runId, action: 'reopen', reason: 'Review again' });
  expect(reopened.sequence).toBeGreaterThan(decision.sequence);
  expect((await inspect(original)).decisions.map((item: { action: string }) => item.action)).toEqual(['dismiss', 'reopen']);
  expect((await db.findingSnapshot.findUniqueOrThrow({ where: { runId: moved.runId } })).report).toEqual(moved);
  // Re-finalization, attempted SQL mutations and subsequent decisions cannot rewrite history.
  const retry = await db.$transaction(tx => snapshotFindingHistory(tx, { ...original, findings: [] }));
  expect(retry).toEqual(original);
  await db.$executeRaw`UPDATE "FindingSnapshot" SET "report" = '{}'::jsonb WHERE "runId" = ${original.runId}::uuid`;
  await db.$executeRaw`UPDATE "FindingDecision" SET "reason" = 'rewritten' WHERE "id" = ${decision.id}::uuid`;
  expect((await db.findingSnapshot.findUniqueOrThrow({ where: { runId: original.runId } })).report).toEqual(original);
  expect((await db.findingDecision.findUniqueOrThrow({ where: { id: decision.id } })).reason).toBe(input.reason);
  expect(await db.finding.count({ where: { pullRequestNumber: 1 } })).toBe(1);
}, 60000);

it('uses explicit Git rename metadata to preserve identity and prior citations', async () => {
  const original = await review('original', 2), renamed = await review('renamed', 2);
  expect(renamed.comparison).toEqual([expect.objectContaining({ status: 'renamed', previousPath: 'src/paginate.ts', path: 'src/pages.ts' })]);
  expect(renamed.findings[0]).toMatchObject({ id: original.findings[0]!.id, evidence: { path: 'src/pages.ts', startLine: 5 } });
  expect(renamed.history!.findings[0]!.state).toBe('still_present');
  expect(original.findings[0]!.id).not.toBe((await db.finding.findFirstOrThrow({ where: { pullRequestNumber: 1 } })).id);
  await inspect(original); await inspect(renamed);
}, 60000);

it('retains evidence without transferring a dismissal to ambiguous matches', async () => {
  const original = await review('original', 3);
  await appendFindingDecision(db, { id: randomUUID(), runId: original.runId, findingId: original.findings[0]!.id, action: 'dismiss', actor: 'raj', reason: 'Fixture' });
  const ambiguous = await review('ambiguous', 3);
  expect(ambiguous.findings).toHaveLength(2);
  expect(ambiguous.history!.findings).toHaveLength(3);
  expect(ambiguous.history!.findings.every(item => item.state === 'needs_verification' && !item.decision)).toBe(true);
  expect(ambiguous.history!.findings.find(item => item.findingId === original.findings[0]!.id)?.lastObservation).toEqual(original.findings[0]);
  await expect(appendFindingDecision(db, { id: randomUUID(), runId: ambiguous.runId, findingId: ambiguous.findings[0]!.id, action: 'dismiss', actor: 'raj', reason: 'Uncertain' })).rejects.toThrow('confirmed');
  await inspect(original); await inspect(ambiguous);
}, 60000);

it('marks skipped files and configuration changes as needing verification', async () => {
  const original = await review('original', 4);
  scanMode = 'skip';
  let skipped: Report;
  try { skipped = await review('fixed', 4); } finally { scanMode = 'real'; }
  expect(skipped.history!.findings[0]).toMatchObject({ state: 'needs_verification', lastObservedRunId: original.runId });
  const changed = await review('fixed', 4, { ...configuration, contextTokens: 8192 });
  expect(changed.history!.findings[0]!.state).toBe('needs_verification');
  await inspect(original); await inspect(skipped); await inspect(changed);
}, 60000);

it('retains a lost model-only observation even when static rechecking succeeds', async () => {
  modelMode = 'novel';
  const original = await review('original', 5); modelMode = 'empty';
  expect(original.findings).toHaveLength(2);
  const moved = await review('moved', 5);
  const model = moved.history!.findings.find(item => item.lastObservation.identity?.kind === 'model');
  expect(model).toMatchObject({ state: 'needs_verification', lastObservedRunId: original.runId });
  expect(moved.history!.findings.find(item => item.lastObservation.identity?.kind === 'static')?.state).toBe('still_present');
  await inspect(original); await inspect(moved);
}, 60000);
