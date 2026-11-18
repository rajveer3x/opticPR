import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { demoManifestSchema, demoReplaySchema, githubConfig, reportSchema } from '../packages/contracts/dist/index.js';
import { PrismaClient } from '../packages/database/dist/index.js';
import { FixtureRepositoryAdapter } from '../packages/repository/dist/index.js';
import { createQueue, scheduleRun, waitForReport } from '../packages/runtime/dist/index.js';
import { createWorker } from '../apps/worker/dist/worker.js';
import { semgrepImage } from '../apps/worker/dist/semgrep.js';

const users = `export function findUser(id: string) {
  const user = id === 'known' ? { id } : undefined;
  if (!user) {
    return undefined;
  }
  return user;
}
`;
const route = `import { findUser as getUser } from './users.js';

export function route(id: string) {
  const user = getUser(id);
  if (!user) return { status: 404 };
  return { status: 200, user };
}
`;
const guardedRoute = `import { findUser as getUser } from './users.js';

export function route(id: string) {
  try {
    const user = getUser(id);
    if (!user) return { status: 404 };
    return { status: 200, user };
  } catch {
    return { status: 404 };
  }
}
`;

const exec = promisify(execFile);
const target = fileURLToPath(new URL('../fixtures/review-demo/', import.meta.url));
const configuration = { ...githubConfig, adapter: 'review-demo-bundle-v1', modelEnabled: false };
const namespace = `review_demo_${randomUUID().replaceAll('-', '')}`;
const url = new URL(process.env.DATABASE_URL);
url.searchParams.set('schema', namespace);
const admin = new PrismaClient(), db = new PrismaClient({ datasourceUrl: url.toString() });
let queue, worker, directory, schemaCreated;
const newBundle = join(target, `${namespace}.bundle`);
const newReplay = join(target, `${namespace}.json`);
async function buildBundle() {
  directory = await mkdtemp(join(tmpdir(), 'opticpr-demo-source-'));
  const git = async (...args) => (await exec('git', ['-C', directory, '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { timeout: 5000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'OpticPR Fixture', GIT_AUTHOR_EMAIL: 'fixture@opticpr.invalid',
      GIT_COMMITTER_NAME: 'OpticPR Fixture', GIT_COMMITTER_EMAIL: 'fixture@opticpr.invalid',
      GIT_AUTHOR_DATE: '2026-11-18T00:00:00Z', GIT_COMMITTER_DATE: '2026-11-18T00:00:00Z' },
  })).stdout.trim();
  async function record(message) {
    await git('add', '--all');
    await git('commit', '--quiet', '-m', message);
    return git('rev-parse', 'HEAD');
  }
  await git('init', '--quiet', '--template=', '--initial-branch=main', '--object-format=sha1');
  const src = join(directory, 'src');
  await mkdir(src);
  await writeFile(join(src, 'users.ts'), users);
  await writeFile(join(src, 'route.ts'), route);
  await writeFile(join(src, 'handled.ts'), guardedRoute.replace('function route(', 'function handledRoute('));
  const baseSha = await record('Return undefined for a missing user');
  await writeFile(join(src, 'users.ts'), users.replace('return undefined;', "throw new Error('User not found');"));
  const breakingSha = await record('Throw on a missing user');
  await writeFile(join(src, 'route.ts'), guardedRoute);
  const fixSha = await record('Handle the missing-user exception in the route');
  await mkdir(target, { recursive: true });
  await git('bundle', 'create', newBundle, 'main');
  const input = { source: 'fixture', repositoryId: 'fixture/missing-user', pullRequestNumber: 1, baseSha };
  return demoManifestSchema.parse({ regression: { ...input, headSha: breakingSha }, fix: { ...input, headSha: fixSha } });
}

async function readCaller(input, path, withDiff) {
  const adapter = await FixtureRepositoryAdapter.openReviewDemo(input);
  try {
    const source = await adapter.fileAt(input.headSha, path);
    const lines = source.trimEnd().split('\n');
    const startLine = lines.findIndex(line => line === '  try {') + 1;
    const endLine = lines.findIndex(line => line === '  } catch {') + 3;
    assert.ok(startLine > 0 && endLine > startLine && lines[endLine - 2] === '    return { status: 404 };');
    const hunk = withDiff ? (await adapter.changedFiles(input.baseSha, input.headSha)).find(file => file.path === path)?.hunk : '';
    if (withDiff) assert.ok(hunk?.includes('+  } catch {'));
    return { revision: input.headSha, path, startLine, endLine, excerpt: lines.slice(startLine - 1, endLine).join('\n'), hunk };
  } finally { await adapter.close(); }
}

try {
  await exec('docker', ['image', 'inspect', semgrepImage], { timeout: 5000 });
  const manifest = await buildBundle();
  const manifestPath = join(target, 'manifest.json');
  await rename(newBundle, join(target, 'repository.bundle'));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await admin.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
  schemaCreated = true;
  const migrations = new URL('../packages/database/prisma/migrations/', import.meta.url);
  for (const name of (await readdir(migrations)).filter(name => /^\d/.test(name)).sort()) {
    const sql = await readFile(new URL(`${name}/migration.sql`, migrations), 'utf8');
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  }
  queue = createQueue(namespace);
  worker = createWorker(db, namespace);
  await worker.waitUntilReady();

  async function generate(scenario, path, diff) {
    const run = await scheduleRun(db, queue, manifest[scenario], configuration);
    const finished = await waitForReport(db, run.id);
    const report = reportSchema.parse(finished.report);
    assert.equal(report.coverage.status, 'complete');
    assert.equal(report.crossFileRecheck?.completed, true);
    return { report, caller: await readCaller(report.input, path, diff), createdAt: finished.createdAt.toISOString(), completedAt: finished.completedAt.toISOString() };
  }
  const regression = await generate('regression', 'src/handled.ts', false);
  const fix = await generate('fix', 'src/route.ts', true);
  assert.equal(regression.report.findings.length, 1);
  assert.equal(regression.report.findings[0].ruleId, 'opticpr.ts-missing-value-throws');
  assert.equal(fix.report.findings.length, 0);
  assert.equal(fix.report.history.findings.length, 1);
  const [cleared] = fix.report.history.findings;
  assert.equal(cleared.state, 'cleared_by_recheck');
  assert.deepEqual(cleared.lastObservation, regression.report.findings[0]);
  assert.equal(cleared.previous.runId, regression.report.runId);
  const replay = demoReplaySchema.parse({ version: 1, regression, fix });
  await writeFile(newReplay, JSON.stringify(replay, null, 2) + '\n');
  await rename(newReplay, join(target, 'replay.json'));
  console.log(JSON.stringify({ regression: regression.report.runId, fix: fix.report.runId }));
} finally {
  await worker?.close();
  await queue?.obliterate({ force: true });
  await queue?.close();
  await db.$disconnect();
  if (schemaCreated) await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
  await admin.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
  await rm(newBundle, { force: true });
  await rm(newReplay, { force: true });
}
