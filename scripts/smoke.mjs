import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PrismaClient } from '../packages/database/dist/index.js';
import { createQueue } from '../packages/runtime/dist/index.js';
import { fixtureConfig, reportSchema } from '../packages/contracts/dist/index.js';
import { FixtureRepositoryAdapter } from '../packages/repository/dist/index.js';

const exec = promisify(execFile);
const namespace = `smoke_${randomUUID().replaceAll('-', '')}`;
const databaseUrl = new URL(process.env.DATABASE_URL); databaseUrl.searchParams.set('schema', namespace);
const admin = new PrismaClient(), db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
await admin.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
const directory = new URL('../packages/database/prisma/migrations/', import.meta.url);
for (const name of (await readdir(directory)).filter(name => /^\d/.test(name)).sort()) {
  for (const statement of (await readFile(new URL(`${name}/migration.sql`, directory), 'utf8')).split(';').map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
}
const queue = createQueue(namespace);
const env = { ...process.env, DATABASE_URL: databaseUrl.toString(), REVIEW_QUEUE: namespace,
  DASHBOARD_ORIGIN: '', GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '', GITHUB_WEBHOOK_SECRET: '', FIXTURE_INSPECTION_ENABLED: '1', PORT: process.env.SMOKE_PORT ?? '31997', HOST: '127.0.0.1' };
const origin = `http://127.0.0.1:${env.PORT}`;
const children = [];
function start(entry) {
  const child = spawn(process.execPath, ['--env-file=.env', entry], { env, stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
  return child;
}
const api = start('apps/api/dist/main.js');
const worker = start('apps/worker/dist/main.js');
let postgresStopped = false;
let adapter;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (api.exitCode !== null || worker.exitCode !== null) throw new Error('API or worker exited during smoke startup');
    try {
      const response = await fetch(`${origin}/health/ready`, { signal: AbortSignal.timeout(1000) });
      ready = response.ok;
    } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'API dependencies must be ready');
  const replay = async () => JSON.parse((await exec(process.execPath, ['--env-file=.env', 'apps/worker/dist/replay.js'], { env, timeout: 45000 })).stdout);
  const first = await replay();
  const second = await replay();
  assert.equal(first.runId, second.runId, 'Two CLI replays must resolve to one durable run');
  const response = await fetch(`${origin}/api/runs/${first.runId}`);
  assert.equal(response.status, 200);
  const stored = await response.json();
  const report = reportSchema.parse(stored.report);
  adapter = await FixtureRepositoryAdapter.open();
  assert.deepEqual(report.input, await adapter.revisions());
  assert.deepEqual(report.configuration, fixtureConfig);
  assert.equal(report.runId, first.runId);
  assert.deepEqual(report.coverage.analyzedFiles, ['src/paginate.ts']);
  assert.equal(report.coverage.scope, 'fixture-rule-only');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].source, 'fixture');
  console.log(`Verified CLI replay and stored HTTP report: ${first.runId}`);
  await admin.$disconnect(); await db.$disconnect();
  await exec('docker', ['compose', 'stop', 'postgres'], { timeout: 30000 });
  postgresStopped = true;
  const outage = await exec(process.execPath, ['--env-file=.env', 'scripts/check-outage.mjs'], { env, timeout: 20000 });
  console.log(outage.stdout.trim());
} finally {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const kill = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('close', () => { clearTimeout(kill); resolve(); });
  })));
  await adapter?.close();
  if (postgresStopped) await exec('docker', ['compose', 'start', '--wait', 'postgres'], { timeout: 60000 });
  await queue.obliterate({ force: true }); await queue.close(); await db.$disconnect();
  await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin.$disconnect();
}
