import { readFile } from 'node:fs/promises';
import { fixtureConfig, githubConfig, inputSchema, reportSchema, shaSchema } from '@opticpr/contracts';
import { PrismaClient } from '@opticpr/database';
import { FixtureRepositoryAdapter } from '@opticpr/repository';
import { createQueue, requireReady, scheduleRun, waitForReport } from '@opticpr/runtime';

const db = new PrismaClient();
let adapter: FixtureRepositoryAdapter | undefined;
let queue: ReturnType<typeof createQueue> | undefined;
try {
  const timeout = Number(process.env.REPLAY_TIMEOUT_MS ?? 30000);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('REPLAY_TIMEOUT_MS must be positive');
  await requireReady(db);
  adapter = await FixtureRepositoryAdapter.open();
  let input = await adapter.revisions();
  const scenario = process.argv[2];
  if (scenario) {
    const history = JSON.parse(await readFile(new URL('../../../fixtures/pagination/history.json', import.meta.url), 'utf8'));
    input = inputSchema.parse({ ...input, baseSha: history.baseSha, headSha: shaSchema.parse(history.scenarios[scenario]) });
    await adapter.close(); adapter = await FixtureRepositoryAdapter.open(input);
  }
  queue = createQueue();
  const run = await scheduleRun(db, queue, input, scenario ? { ...githubConfig, modelEnabled: process.env.MODEL_ENRICHMENT_ENABLED === '1', adapter: 'pagination-bundle-v1' } : fixtureConfig);
  const completed = await waitForReport(db, run.id, timeout);
  const report = reportSchema.parse(completed.report);
  console.log(JSON.stringify({ runId: completed.id, logicalKey: completed.logicalKey, state: completed.state, baseSha: report.input.baseSha, headSha: report.input.headSha }, null, 2));
} catch (error) {
  // Do not print driver errors, which can contain connection credentials.
  const message = error instanceof Error && /^(Dependencies unavailable:|Run |REPLAY_TIMEOUT_MS)/.test(error.message)
    ? error.message : 'Fixture replay failed; check PostgreSQL, migrations, Redis and worker logs';
  console.error(message); process.exitCode = 1;
} finally {
  await queue?.close(); await adapter?.close(); await db.$disconnect();
}
