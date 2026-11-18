import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { reportSchema } from '@opticpr/contracts';
import { PrismaClient } from '@opticpr/database';
import { GitSnapshotAdapter } from '@opticpr/repository';
import { createQueue, digest, scheduleRun, waitForReport } from '@opticpr/runtime';
import { createWorker } from './worker.js';
import { semgrepImage } from './semgrep.js';
import {
  historicalArms, historicalConfigurations, historicalInput, loadHistoricalDataset, scoreHistorical,
  verifiedFindings, type HistoricalAdjudication, type HistoricalSample,
} from './historical-evaluation.js';

const exec = promisify(execFile);
type Arm = typeof historicalArms[number];
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/usr/bin/false', GIT_NO_REPLACE_OBJECTS: '1' };

async function fetchHistory(directory: string, repository: string, heads: string[]) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid reserved GitHub repository');
  await exec('git', ['init', '--bare', '--template=', directory], { env: gitEnv, timeout: 5000 });
  await exec('git', ['-C', directory, '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', 'credential.helper=', '-c', 'http.followRedirects=false', '-c', 'core.hooksPath=/dev/null',
    'fetch', '--depth=2', '--no-tags', '--no-recurse-submodules', `https://github.com/${repository}.git`, ...heads],
  { env: gitEnv, timeout: 90000 });
}

async function migrate(db: PrismaClient) {
  const directory = new URL('../../../packages/database/prisma/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d/.test(name)).sort()) {
    const migration = await readFile(new URL(`${name}/migration.sql`, directory), 'utf8');
    for (const statement of migration.split(';').map(value => value.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  }
}

async function main() {
  const mode = process.argv[2] ?? 'run';
  const output = resolve(process.argv[3] ?? 'output/10-historical');
  const data = await loadHistoricalDataset();
  if (mode === 'score') {
    const raw = JSON.parse(await readFile(join(output, 'raw.json'), 'utf8'));
    if (digest(raw.seal) !== digest(data.seal) || digest(raw.configurations) !== digest(historicalConfigurations)) throw new Error('Raw results use another corpus or configuration');
    const decisions: HistoricalAdjudication[] = process.argv[4] ? JSON.parse(await readFile(resolve(process.argv[4]), 'utf8')) : [];
    const score = scoreHistorical(data.cases, raw.samples, decisions);
    await writeFile(join(output, 'score.json'), JSON.stringify({ ...score, adjudications: decisions }, null, 2) + '\n');
    console.log(JSON.stringify(score.arms, null, 2));
    return;
  }
  if (mode !== 'run') throw new Error('Use run or score');

  await exec('docker', ['image', 'inspect', semgrepImage], { timeout: 5000 });
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });
  const root = await mkdtemp(join(tmpdir(), 'opticpr-historical-'));
  const admin = new PrismaClient();
  const instances: { namespace: string; db: PrismaClient; queue: ReturnType<typeof createQueue>; worker?: ReturnType<typeof createWorker> }[] = [];
  try {
    const directories = new Map<string, string>();
    for (const [index, repository] of data.repositories.entries()) {
      const directory = join(root, String(index));
      const cases = data.cases.filter(item => item.repository === repository);
      await fetchHistory(directory, repository, cases.map(item => historicalInput(item).headSha));
      for (const item of cases) {
        const input = historicalInput(item);
        const { stdout } = await exec('git', ['-C', directory, 'rev-parse', `${input.headSha}^1`], { env: gitEnv, timeout: 5000 });
        if (stdout.trim() !== input.baseSha) throw new Error('Reserved base is not the upstream first parent');
        directories.set(digest(input), directory);
      }
    }
    const snapshot = (input: HistoricalSample['input']) => {
      const directory = directories.get(digest(input));
      if (!directory) throw new Error('Comparison outside the reserved historical corpus');
      return new GitSnapshotAdapter(directory, input);
    };
    const environment = {
      platform: platform(), architecture: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version,
      git: (await exec('git', ['--version'], { timeout: 5000 })).stdout.trim(),
      docker: (await exec('docker', ['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'], { timeout: 5000 })).stdout.trim(),
      opticprCommit: (await exec('git', ['rev-parse', 'HEAD'], { timeout: 5000 })).stdout.trim(),
      opticprWorktreeDirty: !!(await exec('git', ['status', '--porcelain'], { timeout: 5000 })).stdout.trim(),
      semgrepImage,
    };
    const samples: HistoricalSample[] = [];
    const raw = { version: 1, startedAt: new Date().toISOString(), seal: data.seal, labelReview: data.labelReview,
      configurations: historicalConfigurations, environment,
      methodology: 'Serial paired runs, alternating which arm goes first, with isolated database schemas and queues. One run per arm and case. Timer includes scheduling, queue, pinned source reads, analysis and report finalization. Remote Git fetch and independent citation checks are outside the timer. No special cache reset or warm-up.', samples };
    const persist = () => writeFile(join(output, 'raw.json'), JSON.stringify(raw, null, 2) + '\n');
    await persist();
    const workers = new Map<Arm, typeof instances[number]>();
    for (const arm of historicalArms) {
      const namespace = `historical_${randomUUID().replaceAll('-', '')}`;
      const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('schema', namespace);
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
      const instance: typeof instances[number] = {
        namespace, db: new PrismaClient({ datasourceUrl: url.toString() }), queue: createQueue(namespace),
      };
      instances.push(instance);
      await migrate(instance.db);
      await instance.queue.waitUntilReady();
      instance.worker = createWorker(instance.db, namespace, undefined, { historicalSnapshot: snapshot });
      await instance.worker.waitUntilReady();
      workers.set(arm, instance);
    }
    for (const [index, item] of data.cases.entries()) {
      const input = historicalInput(item);
      const order = index % 2 ? [...historicalArms].reverse() : historicalArms;
      for (const arm of order) {
        const { db, queue } = workers.get(arm)!;
        const started = performance.now();
        const run = await scheduleRun(db, queue, input, historicalConfigurations[arm]);
        const report = reportSchema.parse((await waitForReport(db, run.id, 120000)).report);
        const elapsedMs = Math.round(performance.now() - started);
        const { runId, configurationDigest, findings, coverage, stages } = report;
        const verifiedEvidence = await verifiedFindings(report, snapshot(input));
        samples.push({ caseId: item.id, arm, input, runId, configurationDigest, findings, coverage, stages, elapsedMs, verifiedEvidence });
        await persist();
        console.log(JSON.stringify({ caseId: item.id, arm, runId, elapsedMs, findings: findings.length, coverage: coverage.status }));
      }
    }
    const score = scoreHistorical(data.cases, samples);
    await writeFile(join(output, 'score.json'), JSON.stringify({ ...score, adjudications: [] }, null, 2) + '\n');
    console.log(JSON.stringify(score.arms, null, 2));
    if (samples.some(sample => sample.stages.some(stage => stage.name === 'semgrep' && stage.status === 'failed'))) {
      throw new Error('Semgrep failed during at least one replay; see the saved stage outcomes before interpreting the measurements');
    }
  } finally {
    for (const { worker, queue, db, namespace } of instances) {
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await admin.$disconnect();
    await rm(root, { recursive: true, force: true });
  }
}

void main().catch(error => {
  // Failed Git fetch and Docker commands can contain paths or environment-dependent values.
  console.error(error instanceof Error && !('cmd' in error) ? error.message : 'Historical replay failed; check public Git access and the pinned scanner image.');
  process.exitCode = 1;
});
