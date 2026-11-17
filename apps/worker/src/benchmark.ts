import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { arch, cpus, platform, totalmem } from 'node:os';
import { githubConfig, modelOutputSchema, type LocalConfig } from '@opticpr/contracts';
import { PrismaClient, type Prisma } from '@opticpr/database';
import { FixtureRepositoryAdapter } from '@opticpr/repository';
import { requireReady, runIdentity } from '@opticpr/runtime';
import { analyzeLocal, type AnalysisServices } from './local-analysis.js';
import { ollamaClient, ollamaUrl } from './inference.js';
import { headHunks, sourceContexts } from './context.js';

const exec = promisify(execFile);
const db = new PrismaClient();
const origin = ollamaUrl();
const output = resolve(process.argv[2] ?? 'context/benchmarks/04-local-analysis.json');
const results: unknown[] = [];
let adapter: FixtureRepositoryAdapter | undefined;
try {
  await requireReady(db);
  const version = await fetch(`${origin}/api/version`, { signal: AbortSignal.timeout(5000) }).then(response => response.json());
  adapter = await FixtureRepositoryAdapter.open();
  const input = await adapter.revisions();
  const changes = await adapter.changedFiles(input.baseSha, input.headSha);
  for (const contextTokens of [4096, 8192] as const) for (const contextMode of ['diff-only', 'function-context'] as const) {
    const configuration: LocalConfig = { ...githubConfig, adapter: 'pagination-bundle-v1', contextTokens, contextMode };
    const identity = runIdentity(input, configuration);
    const run = await db.reviewRun.upsert({ where: { logicalKey: identity.logicalKey },
      create: { ...input, ...identity, configuration, state: 'running' }, update: { state: 'running', error: null } });
    let modelLatencyMs: number | null = null;
    let candidates: unknown = null;
    let peakRunnerRssBytes = 0;
    const sample = async () => {
      const { stdout } = await exec('ps', ['-axo', 'rss=,comm=']);
      const rss = stdout.split('\n').filter(line => /ollama.*runner|llama-server/.test(line)).reduce((sum, line) => sum + Number(/^\s*(\d+)/.exec(line)?.[1] ?? 0) * 1024, 0);
      peakRunnerRssBytes = Math.max(peakRunnerRssBytes, rss);
    };
    let sampling = false;
    const timer = setInterval(() => {
      if (sampling) return; sampling = true;
      void sample().catch(() => {}).finally(() => { sampling = false; });
    }, 250);
    const client = ollamaClient(origin);
    const services: AnalysisServices = { inference: async request => {
      const start = performance.now();
      try {
        const raw = await client(request);
        const parsed = modelOutputSchema.safeParse(JSON.parse(raw));
        if (parsed.success) candidates = parsed.data.candidates;
        return raw;
      } finally { modelLatencyMs = Math.round(performance.now() - start); }
    } };
    const started = performance.now();
    let report: Awaited<ReturnType<typeof analyzeLocal>>;
    try { report = await analyzeLocal(db, adapter, input, configuration, { runId: run.id, ...identity }, services); }
    finally { clearInterval(timer); await sample(); }
    const elapsedMs = Math.round(performance.now() - started);
    await db.reviewRun.update({ where: { id: run.id }, data: { report: report as Prisma.InputJsonValue, state: 'completed', completedAt: new Date() } });
    const loaded = await fetch(`${origin}/api/ps`, { signal: AbortSignal.timeout(5000) }).then(response => response.json()) as { models?: { name: string; size: number; size_vram: number; context_length?: number }[] };
    const model = loaded.models?.find(model => model.name === configuration.model);
    const contextKinds: string[] = [];
    for (const change of changes) {
      const source = await adapter.fileAt(input.headSha, change.path);
      contextKinds.push(...(await sourceContexts(input.headSha, change.path, source, headHunks(change.hunk), contextMode)).map(context => context.kind));
    }
    const result = { contextTokens, contextMode, runId: run.id, elapsedMs, modelLatencyMs, peakRunnerRssBytes,
      loadedModelBytes: model?.size ?? null, acceleratorBytes: model?.size_vram ?? null, loadedContextTokens: model?.context_length ?? null,
      coverage: report.coverage.status, staticAlerts: report.findings.filter(finding => !finding.ruleId.startsWith('model:')).length,
      enrichment: report.enrichment, candidates, contextKinds };
    results.push(result);
    console.log(JSON.stringify(result));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, totalMemoryBytes: totalmem() },
      ollama: version, model: configuration.model, modelRevision: configuration.modelRevision, input, results,
      methodology: 'One sample per setting, deterministic seed and temperature; no explicit cold-cache reset, with model reloads when context size changes. RSS samples every 250ms; loaded/accelerator bytes from Ollama /api/ps. Quality uses exact-evidence acceptance and the known pagination regression. The five-line fixture fits both modes and cannot establish broad comparative review quality.' }, null, 2) + '\n');
  }
  console.log(`Benchmark written: ${output}`);
} catch { console.error('Benchmark failed; check migrations, pinned scanner image and local Ollama.'); process.exitCode = 1; }
finally { await adapter?.close(); await db.$disconnect(); }
