import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { githubConfig, type Report } from '../packages/contracts/src/index.js';
import { FixtureRepositoryAdapter } from '../packages/repository/src/index.js';
import { runIdentity } from '../packages/runtime/src/index.js';
import { loadEvaluationDataset, percentile, scoreEvaluation, type EvaluationCase, type EvaluationSample } from '../apps/worker/src/evaluation.js';

const dataset = await loadEvaluationDataset();
for (const item of dataset.cases) it(`confirms base/head behavior and label evidence for ${item.id}`, async () => {
  // Only the sealed checked-in synthetic source and assertions run here.
  for (const check of item.checks) {
    const execute = (source: string) => {
      const javascript = ts.transpileModule(source.replaceAll('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      return JSON.parse(JSON.stringify(runInNewContext(`${javascript}\n${check.expression}`, {}, { timeout: 500 })));
    };
    expect(execute(item.base)).toEqual(check.expected);
    if (check.defectId) expect(execute(item.head)).not.toEqual(check.expected);
    else expect(execute(item.head)).toEqual(check.expected);
  }
  const adapter = await FixtureRepositoryAdapter.openEvaluation(dataset.manifest[item.id]!);
  try {
    expect(await adapter.fileAt(dataset.manifest[item.id]!.headSha, 'src/change.ts')).toBe(item.head);
    expect(await adapter.fileAt(dataset.manifest[item.id]!.baseSha, 'src/change.ts')).toBe(item.base);
    expect(await adapter.changedFiles(dataset.manifest[item.id]!.baseSha, dataset.manifest[item.id]!.headSha)).toHaveLength(1);
  } finally { await adapter.close(); }
});

async function sample(item: EvaluationCase, arm: EvaluationSample['arm']): Promise<EvaluationSample> {
  const input = dataset.manifest[item.id]!;
  const config = { ...githubConfig, adapter: 'evaluation-bundle-v1' as const, modelEnabled: arm !== 'semgrep', contextMode: arm === 'diff-only' ? 'diff-only' as const : 'function-context' as const };
  const adapter = await FixtureRepositoryAdapter.openEvaluation(input);
  try {
    const hunk = (await adapter.changedFiles(input.baseSha, input.headSha))[0]!.hunk;
    const label = item.labels[0]!;
    const startLine = label.evidence.startLine, endLine = label.evidence.endLine;
    const report: Report = { schemaVersion: 1, runId: randomUUID(), ...runIdentity(input, config), input, configuration: config, source: 'fixture', stages: [],
      coverage: { status: 'complete', scope: 'local-js-ts', changedFiles: ['src/change.ts'], analyzedFiles: ['src/change.ts'], skippedFiles: [], detail: 'Test' }, comparison: [{ path: 'src/change.ts', hunk }],
      findings: [{ id: randomUUID(), source: 'fixture', ruleId: arm === 'semgrep' ? label.staticRules[0] ?? 'unmatched' : 'model:boundary', severity: 'medium', title: 'Test', impact: 'Test', verification: 'Check fixture',
        evidence: { revision: input.headSha, path: 'src/change.ts', startLine, endLine, excerpt: item.head.split('\n').slice(startLine - 1, endLine).join('\n'), hunk } }] };
    return { caseId: item.id, arm, elapsedMs: 100, report };
  } finally { await adapter.close(); }
}
it('counts matches once, duplicates as false findings, and misses independently', async () => {
  const item = dataset.cases.find(item => item.id === 'page-01')!;
  const row = await sample(item, 'semgrep');
  row.report.findings.push({ ...row.report.findings[0]!, id: randomUUID() });
  const result = scoreEvaluation([item], [row]).arms[0]!;
  expect(result).toMatchObject({ matched: 1, missed: 0, falseFindings: 1, precision: .5, recall: 1, eligibleForDefault: false });
  row.report.findings[0]!.evidence.revision = '0'.repeat(40);
  expect(scoreEvaluation([item], [row]).arms[0]).toMatchObject({ matched: 0, missed: 1, falseFindings: 2, validAnchors: 0 });
});
it('requires reasoned model adjudication and a complete held-out comparison for default enablement', async () => {
  const item = dataset.cases.find(item => item.id === 'page-02')!;
  const baseline = await sample(item, 'semgrep'); baseline.report.findings = [];
  const model = await sample(item, 'function-context');
  expect(scoreEvaluation([item], [baseline, model]).arms[2]).toMatchObject({ unadjudicated: 1, precision: null, eligibleForDefault: false });
  const decision = { caseId: item.id, arm: model.arm, findingId: model.report.findings[0]!.id, labelId: item.labels[0]!.id, labeler: 'test', reason: 'Confirms the offset check' };
  expect(scoreEvaluation([item], [baseline, model], [decision]).arms[2]).toMatchObject({ matched: 1, additionalTrueFindings: 1, precision: 1, eligibleForDefault: true });
  expect(scoreEvaluation([item], [model], [decision]).arms[2]!.eligibleForDefault).toBe(false);
  expect(() => scoreEvaluation([item], [baseline, model], [decision, decision])).toThrow('adjudication');
  expect(() => scoreEvaluation([item], [baseline, baseline])).toThrow('duplicate sample');
});
it('counts flagged clean PRs and unsafe clearances on incomplete scans', async () => {
  const item = dataset.cases.find(item => item.id === 'page-01')!;
  const row = await sample(item, 'semgrep');
  const clean = { ...item, labels: [] };
  row.report.history = { previousRunId: null, findings: [{ findingId: randomUUID(), state: 'cleared_by_recheck', reason: 'Invalid', lastObservation: row.report.findings[0]!, lastObservedRunId: row.report.runId, lastObservedConfigurationDigest: row.report.configurationDigest }] };
  expect(scoreEvaluation([clean], [row]).arms[0]).toMatchObject({ cleanPrsFlagged: 1, falseFindings: 1, falseClearances: 1 });
  row.report.recheck = { completed: true, rules: [], files: ['src/change.ts'], observations: [] };
  expect(scoreEvaluation([clean], [row]).arms[0]!.falseClearances).toBe(1);
  row.report.recheck.rules = [row.report.findings[0]!.ruleId];
  expect(scoreEvaluation([clean], [row]).arms[0]!.falseClearances).toBe(0);
  expect(percentile([1, 2, 3, 100], .95)).toBe(100);
  expect(percentile([], .5)).toBeNull();
});
