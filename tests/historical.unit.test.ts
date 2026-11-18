import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { runIdentity } from '../packages/runtime/src/index.js';
import {
  historicalArms, historicalConfigurations, historicalInput, loadHistoricalDataset, scoreHistorical,
  type HistoricalSample,
} from '../apps/worker/src/historical-evaluation.js';

it('keeps entire public repositories held out and changes only the cross-file rule between arms', async () => {
  const data = await loadHistoricalDataset();
  expect(data.labelReview).toMatchObject({ status: 'provisional', independentReviewer: null });
  for (const repository of data.repositories) {
    const cases = data.cases.filter(item => item.repository === repository);
    expect(cases.some(item => item.labels.length > 0)).toBe(true);
    expect(cases.some(item => item.labels.length === 0)).toBe(true);
  }
  const { crossFileRuleRevision, ...comparable } = historicalConfigurations['semgrep-plus-cross-file'];
  expect(crossFileRuleRevision).toBe('ts-missing-value-throws-v1');
  expect(comparable).toEqual(historicalConfigurations.semgrep);
});

it('reports paired misses on partial scans and scores verified, rejected and duplicate findings by label', async () => {
  const { cases } = await loadHistoricalDataset();
  const samples: HistoricalSample[] = cases.flatMap((item, index) => historicalArms.map(arm => {
    const input = historicalInput(item);
    return { input, runId: randomUUID(), caseId: item.id, arm, elapsedMs: (index + 1) * 100,
      configurationDigest: runIdentity(input, historicalConfigurations[arm]).configurationDigest,
      coverage: { scope: 'local-js-ts', status: index === 2 ? 'partial' : 'complete', changedFiles: [], analyzedFiles: [], skippedFiles: [], detail: '' },
      stages: [], findings: [], verifiedEvidence: [] };
  }));
  expect(scoreHistorical(cases, samples).arms[1]).toMatchObject({ missedDefects: 2, missesOnPartialScans: 1, p50Ms: 200, p95Ms: 400 });
  const regression = samples[1]!;
  const clean = samples[3]!;
  const label = cases[0]!.labels[0]!;
  const evidence = { ...label.evidence[0]!, revision: regression.input.headSha, excerpt: 'proof', hunk: '' };
  const alert = { id: 'match', source: 'fixture' as const, ruleId: 'sample-rule', severity: 'medium' as const, title: 'Claim', impact: '', verification: '', evidence };
  regression.findings = [alert, { ...alert, id: 'duplicate' }];
  regression.verifiedEvidence = ['match', 'duplicate'];
  clean.findings = [{ ...alert, id: 'clean-alert' }];
  clean.verifiedEvidence = ['clean-alert'];
  const decision = (sample: HistoricalSample, findingId: string, labelId: string | null) =>
    ({ caseId: sample.caseId, arm: sample.arm, findingId, labelId, reviewer: 'Test reviewer', reason: 'Synthetic scoring check' });
  expect(scoreHistorical(cases, samples).arms[1]).toMatchObject({ unadjudicatedFindings: 3, cleanComparisonsFlagged: 1 });
  expect(scoreHistorical(cases, samples, [
    decision(regression, 'match', label.id), decision(regression, 'duplicate', label.id), decision(clean, 'clean-alert', null),
  ]).arms[1]).toMatchObject({
    verifiedDefects: 1, additionalVerifiedDefects: 1, missedDefects: 1, falseFindings: 2, findings: 3,
    cleanComparisonsFlagged: 1, cleanComparisons: 2, unadjudicatedFindings: 0,
  });
  expect(() => scoreHistorical(cases, samples.slice(1))).toThrow('both arms');
});
