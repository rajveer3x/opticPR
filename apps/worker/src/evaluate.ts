import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { arch, cpus, platform, totalmem } from 'node:os';
import { githubConfig, reportSchema, type LocalConfig } from '@opticpr/contracts';
import { PrismaClient } from '@opticpr/database';
import { createQueue, digest, runIdentity, scheduleRun, waitForReport } from '@opticpr/runtime';
import { createWorker } from './worker.js';
import { ollamaClient, ollamaUrl } from './inference.js';
import { evaluationArms, loadEvaluationDataset, scoreEvaluation, type Adjudication, type EvaluationSample } from './evaluation.js';
import { semgrepImage } from './semgrep.js';

async function main() {
  const mode = process.argv[2] ?? 'run';
  const output = resolve(process.argv[3] ?? 'context/evaluation/08-held-out');
  const dataset = await loadEvaluationDataset();
  if (mode === 'score') {
    const raw = JSON.parse(await readFile(`${output}/raw.json`, 'utf8'));
    if (JSON.stringify(raw.datasetSeal) !== JSON.stringify(dataset.seal)) throw new Error('Results do not match the sealed dataset');
    if (!['tuning', 'evaluation'].includes(raw.split)) throw new Error('Invalid recorded split');
    for (const sample of raw.samples as EvaluationSample[]) {
      const expected = dataset.manifest[sample.caseId];
      const configuration = raw.configurations[sample.arm];
      if (!expected || !configuration || digest(expected) !== digest(sample.report.input) ||
          digest(configuration) !== digest(sample.report.configuration) || runIdentity(expected, configuration).configurationDigest !== sample.report.configurationDigest ||
          runIdentity(expected, configuration).logicalKey !== sample.report.logicalKey) throw new Error('Recorded sample identity changed');
    }
    const configs = evaluationArms.map(arm => raw.configurations[arm]);
    if (configs.some((config, index) => !config || config.adapter !== 'evaluation-bundle-v1' || config.modelEnabled !== (index !== 0) || config.contextMode !== (index === 1 ? 'diff-only' : 'function-context')) ||
        digest({ ...configs[1], modelEnabled: false, contextMode: 'function-context' }) !== digest(configs[0]) ||
        digest({ ...configs[2], modelEnabled: false }) !== digest(configs[0])) throw new Error('Model arms used different settings');
    const adjudications: Adjudication[] = process.argv[4] ? JSON.parse(await readFile(resolve(process.argv[4]), 'utf8')) : [];
    const score = scoreEvaluation(dataset.cases.filter(item => item.split === raw.split), raw.samples, adjudications);
    await writeFile(`${output}/score.json`, JSON.stringify({ measuredAt: raw.startedAt, adjudications, ...score }, null, 2) + '\n');
    console.log(JSON.stringify(score.arms, null, 2));
  } else if (mode === 'run') {
    const split = process.argv[4] ?? 'evaluation';
    if (!['evaluation', 'tuning'].includes(split)) throw new Error('Choose evaluation or tuning');
    const origin = ollamaUrl();
    const versionResponse = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(5000) });
    if (!versionResponse.ok) throw new Error('Local Ollama unavailable');
    const version = await versionResponse.json();
    const tags = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(5000) }).then(response => response.json()) as { models: { name: string; digest: string }[] };
    if (!tags.models.some(model => model.name === githubConfig.model && `sha256:${model.digest}` === githubConfig.modelRevision)) throw new Error('Pinned model unavailable');
    // A new folder prevents accidental replacement of held-out measurements.
    await mkdir(output, { recursive: false });
    const namespace = `evaluation_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(process.env.DATABASE_URL!); url.searchParams.set('schema', namespace);
    const admin = new PrismaClient(), db = new PrismaClient({ datasourceUrl: url.toString() });
    const queue = createQueue(namespace);
    const samples: EvaluationSample[] = [];
    const configurations: Record<string, LocalConfig> = Object.fromEntries(evaluationArms.map(arm => [arm, {
      ...githubConfig, adapter: 'evaluation-bundle-v1', modelEnabled: arm !== 'semgrep', contextMode: arm === 'diff-only' ? 'diff-only' : 'function-context',
    }]));
    const raw = { version: 1, startedAt: new Date().toISOString(), split, datasetSeal: dataset.seal, labeler: dataset.labeler,
      disputes: dataset.disputes, independentReview: dataset.independentReview, splitPolicy: dataset.splitPolicy,
      machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, cpus: cpus().length, memoryBytes: totalmem() },
      runtime: { node: process.version, ollama: version, semgrepImage }, configurations,
      conditions: 'Sequential concurrency-one normal queue/worker; static then diff then function for each case. No cold-cache reset or warm-up; model residency recorded before each model arm. One sample per case/arm. Labels and checks never sent to inference. No prompt changes after reservation.', samples };
    const persist = () => writeFile(`${output}/raw.json`, JSON.stringify(raw, null, 2) + '\n');
    let worker: ReturnType<typeof createWorker> | undefined;
    let modelResponse: string | undefined;
    try {
      await admin.$executeRawUnsafe(`CREATE SCHEMA "${namespace}"`);
      const directory = new URL('../../../packages/database/prisma/migrations/', import.meta.url);
      for (const name of (await readdir(directory)).filter(name => /^\d/.test(name)).sort()) {
        for (const statement of (await readFile(new URL(`${name}/migration.sql`, directory), 'utf8')).split(';').map(value => value.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
      }
      const client = ollamaClient(origin);
      worker = createWorker(db, namespace, undefined, { inference: async request => { modelResponse = await client(request); return modelResponse; } });
      await worker.waitUntilReady();
      await persist();
      for (const item of dataset.cases.filter(item => item.split === split)) for (const arm of evaluationArms) {
        modelResponse = undefined;
        let modelLoadedBefore: boolean | undefined;
        if (arm !== 'semgrep') {
          const loaded = await fetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(5000) }).then(response => response.json()) as { models?: { name: string }[] };
          modelLoadedBefore = !!loaded.models?.some(model => model.name === githubConfig.model);
        }
        const start = performance.now();
        const run = await scheduleRun(db, queue, dataset.manifest[item.id]!, configurations[arm]!);
        const report = reportSchema.parse((await waitForReport(db, run.id, 180000)).report);
        samples.push({ caseId: item.id, arm, elapsedMs: Math.round(performance.now() - start), report, modelResponse, modelLoadedBefore });
        await persist();
        console.log(JSON.stringify({ caseId: item.id, arm, runId: run.id, findings: report.findings.length, model: report.enrichment?.status, elapsedMs: samples.at(-1)!.elapsedMs }));
      }
      await writeFile(`${output}/score.json`, JSON.stringify(scoreEvaluation(dataset.cases.filter(item => item.split === split), samples), null, 2) + '\n');
    } finally {
      await persist();
      await worker?.close(); await queue.obliterate({ force: true }); await queue.close(); await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await admin.$disconnect();
    }
  } else throw new Error('Use run or score');

}
void main().catch(() => { console.error('Evaluation failed; check services, pinned model, dataset seal and output directory.'); process.exitCode = 1; });
