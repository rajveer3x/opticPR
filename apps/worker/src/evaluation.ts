import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { reportSchema, type Report, type ReviewInput } from '@opticpr/contracts';
import { validAnchor } from './local-analysis.js';

export const evaluationArms = ['semgrep', 'diff-only', 'function-context'] as const;
export type EvaluationArm = typeof evaluationArms[number];
export interface EvaluationLabel {
  id: string; expectedBehavior: string; evidence: { path: string; startLine: number; endLine: number };
  staticRules: string[]; confirmingChecks: number[];
}
export interface EvaluationCase {
  id: string; domain: string; split: 'tuning' | 'evaluation'; group: string; kind: string; base: string; head: string;
  labels: EvaluationLabel[]; checks: { expression: string; expected: unknown; defectId: string | null }[];
}
export interface EvaluationSample {
  caseId: string; arm: EvaluationArm; elapsedMs: number; report: Report;
  modelResponse?: string; modelLoadedBefore?: boolean;
}
export interface Adjudication {
  caseId: string; arm: EvaluationArm; findingId: string; labelId: string | null; labeler: string; reason: string;
}
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
export async function loadEvaluationDataset() {
  const root = new URL('../../../fixtures/evaluation/', import.meta.url);
  const [casesBytes, manifestBytes, bundle, sealBytes] = await Promise.all(['cases.json', 'manifest.json', 'repository.bundle', 'seal.json'].map(path => readFile(new URL(path, root))));
  const seal = JSON.parse(sealBytes!.toString());
  if (sha256(casesBytes!) !== seal.casesSha256 || sha256(manifestBytes!) !== seal.manifestSha256 || sha256(bundle!) !== seal.bundleSha256) throw new Error('Sealed evaluation dataset changed');
  const dataset = JSON.parse(casesBytes!.toString()) as { version: number; labeler: string; disputes: unknown[]; independentReview: boolean; splitPolicy: string; cases: EvaluationCase[] };
  const manifest = JSON.parse(manifestBytes!.toString()) as Record<string, ReviewInput>;
  if (dataset.cases.length !== 30 || new Set(dataset.cases.map(item => item.id)).size !== 30 ||
      dataset.cases.filter(item => item.kind === 'single-defect').length !== 12 || dataset.cases.filter(item => item.kind === 'multi-defect').length !== 6 || dataset.cases.filter(item => item.kind === 'clean').length !== 12) throw new Error('Invalid dataset balance');
  const groups = new Map<string, string>();
  for (const item of dataset.cases) {
    if (groups.has(item.group) && groups.get(item.group) !== item.split) throw new Error('Related revisions cross the split');
    groups.set(item.group, item.split);
    if (!manifest[item.id] || item.labels.some(label => !label.confirmingChecks.length)) throw new Error('Missing input or confirming check');
  }
  for (const split of ['tuning', 'evaluation'] as const) {
    const ids = dataset.cases.filter(item => item.split === split).map(item => item.id);
    if (ids.length !== (split === 'tuning' ? 10 : 20) || JSON.stringify(ids) !== JSON.stringify(seal.splits[split])) throw new Error('Invalid reserved split');
  }
  return { ...dataset, manifest, seal };
}
function labelContains(label: EvaluationLabel, finding: Report['findings'][number]) {
  const proof = finding.evidence;
  return label.evidence.path === proof.path && proof.startLine >= label.evidence.startLine && proof.endLine <= label.evidence.endLine;
}
export function percentile(values: number[], quantile: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]!;
}
/** Scoring never guesses model correctness from an anchor or title. Novel model
 * findings need an explicit, reasoned adjudication against the confirming check. */
export function scoreEvaluation(cases: EvaluationCase[], samples: EvaluationSample[], adjudications: Adjudication[] = []) {
  const sampleKeys = new Set<string>();
  const decisionKeys = new Set<string>();
  const key = (caseId: string, arm: string, findingId: string) => `${caseId}/${arm}/${findingId}`;
  for (const decision of adjudications) {
    const id = key(decision.caseId, decision.arm, decision.findingId);
    if (decisionKeys.has(id) || !decision.labeler.trim() || !decision.reason.trim() || !samples.some(sample => sample.caseId === decision.caseId && sample.arm === decision.arm && sample.report.findings.some(finding => finding.id === decision.findingId))) throw new Error('Invalid or duplicate adjudication');
    decisionKeys.add(id);
  }
  const rows = samples.map(sample => {
    const sampleKey = `${sample.caseId}/${sample.arm}`;
    if (sampleKeys.has(sampleKey) || !evaluationArms.includes(sample.arm) || !Number.isFinite(sample.elapsedMs) || sample.elapsedMs < 0) throw new Error('Invalid or duplicate sample');
    sampleKeys.add(sampleKey);
    const item = cases.find(item => item.id === sample.caseId);
    if (!item) throw new Error('Sample outside selected split');
    const report = reportSchema.parse(sample.report);
    const matched = new Set<string>();
    const matches: { findingId: string; labelId: string }[] = [];
    const falseFindings: string[] = [], unadjudicated: string[] = [];
    let anchors = 0, validAnchors = 0;
    for (const finding of report.findings) {
      const proofs = [finding.evidence, ...(finding.citations ?? []).map(citation => citation.evidence)];
      const valid = (proof: typeof finding.evidence) => proof.revision === report.input.headSha && proof.path === 'src/change.ts' &&
        validAnchor({ path: proof.path, source: item.head, change: { path: proof.path, hunk: report.comparison?.find(change => change.path === proof.path)?.hunk ?? '' } }, proof);
      anchors += proofs.length; validAnchors += proofs.filter(valid).length;
      const decision = adjudications.find(decision => key(decision.caseId, decision.arm, decision.findingId) === key(item.id, sample.arm, finding.id));
      let label = item.labels.find(label => label.staticRules.includes(finding.ruleId) && labelContains(label, finding));
      if (decision) {
        label = decision.labelId === null ? undefined : item.labels.find(label => label.id === decision.labelId && labelContains(label, finding));
        if (decision.labelId !== null && !label) throw new Error('Adjudication outside acceptable evidence range');
      } else if (finding.ruleId.startsWith('model:')) { unadjudicated.push(finding.id); continue; }
      if (label && !matched.has(label.id) && proofs.every(valid)) {
        matched.add(label.id); matches.push({ findingId: finding.id, labelId: label.id });
      } else falseFindings.push(finding.id);
    }
    const falseClearances = (report.history?.findings ?? []).filter(entry => entry.state === 'cleared_by_recheck' &&
      (!report.recheck?.completed || !report.recheck.files.includes(entry.lastObservation.evidence.path) || !report.recheck.rules.includes(entry.lastObservation.ruleId) || entry.lastObservedConfigurationDigest !== report.configurationDigest || report.coverage.skippedFiles.some(file => file.path === entry.lastObservation.evidence.path))).map(entry => entry.findingId);
    return { caseId: item.id, arm: sample.arm, runId: report.runId, elapsedMs: sample.elapsedMs, matches,
      missed: item.labels.filter(label => !matched.has(label.id)).map(label => label.id), falseFindings, unadjudicated,
      cleanFlagged: item.labels.length === 0 && report.findings.length > 0, anchors, validAnchors, falseClearances,
      coverage: report.coverage.status, enrichment: report.enrichment?.status ?? 'skipped' };
  });
  const arms = evaluationArms.map(arm => {
    const selected = rows.filter(row => row.arm === arm);
    const matched = selected.reduce((n, row) => n + row.matches.length, 0), missed = selected.reduce((n, row) => n + row.missed.length, 0);
    const falseFindings = selected.reduce((n, row) => n + row.falseFindings.length, 0), unadjudicated = selected.reduce((n, row) => n + row.unadjudicated.length, 0);
    const anchors = selected.reduce((n, row) => n + row.anchors, 0), validAnchors = selected.reduce((n, row) => n + row.validAnchors, 0);
    const baseline = new Set(rows.filter(row => row.arm === 'semgrep').flatMap(row => row.matches.map(match => `${row.caseId}/${match.labelId}`)));
    const additionalTrueFindings = selected.flatMap(row => row.matches.filter(match => !baseline.has(`${row.caseId}/${match.labelId}`))).length;
    const complete = selected.length === cases.length && cases.every(item => selected.some(row => row.caseId === item.id));
    const baselineComplete = rows.filter(row => row.arm === 'semgrep').length === cases.length;
    const precision = unadjudicated || !matched && !falseFindings ? null : matched / (matched + falseFindings);
    const falseClearances = selected.reduce((n, row) => n + row.falseClearances.length, 0);
    return { arm, samples: selected.length, complete, matched, missed, falseFindings, unadjudicated, precision,
      recall: matched + missed ? matched / (matched + missed) : null,
      cleanPrs: cases.filter(item => !item.labels.length).length, cleanPrsFlagged: selected.filter(row => row.cleanFlagged).length,
      anchors, validAnchors, exactAnchorValidity: anchors ? validAnchors / anchors : null, falseClearances,
      incompleteScans: selected.filter(row => row.coverage !== 'complete').length,
      modelFailures: selected.filter(row => row.enrichment === 'failed').length,
      p50Ms: percentile(selected.map(row => row.elapsedMs), .5), p95Ms: percentile(selected.map(row => row.elapsedMs), .95),
      additionalTrueFindings, eligibleForDefault: arm !== 'semgrep' && complete && baselineComplete && cases.every(item => item.split === 'evaluation') &&
        unadjudicated === 0 && additionalTrueFindings > 0 && precision !== null && precision >= .8 && validAnchors === anchors && falseClearances === 0 };
  });
  return { methodology: 'One-to-one defect matching within labeled evidence ranges. Duplicate alerts count as false findings. Static rules match predeclared labels; novel model alerts require reasoned adjudication. Unjudged alerts block precision and default enablement. Nearest-rank latency percentiles include queue, analysis and durable finalization; exclude webhook, remote publication and label checks.', rows, arms };
}
