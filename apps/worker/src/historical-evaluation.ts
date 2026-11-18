import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { githubConfig, inputSchema, localAnalysisBaseline, type Finding, type LocalConfig, type Report, type ReviewInput } from '@opticpr/contracts';
import type { RepositoryAdapter } from '@opticpr/repository';
import { digest, runIdentity } from '@opticpr/runtime';
import { percentile } from './evaluation.js';
import { validAnchor } from './local-analysis.js';

export const historicalArms = ['semgrep', 'semgrep-plus-cross-file'] as const;
type Arm = typeof historicalArms[number];
type Range = Pick<Finding['evidence'], 'path' | 'startLine' | 'endLine'>;
interface HistoricalLabel { id: string; report: string; fix: string; fixSha: string; expected: string; evidence: Range[] }
export interface HistoricalCase {
  id: string; repository: string; number: number; baseSha: string; headSha: string;
  reference: string; cleanBehavior?: string; labels: HistoricalLabel[];
}
interface HistoricalDataset {
  version: 1; reservedOn: string; split: 'held-out'; repositories: string[];
  labelReview: { status: 'provisional' | 'reviewed'; independentReviewer: string | null; disagreements: { caseId: string; issue: string; resolution: string }[] };
  cases: HistoricalCase[];
}
export type HistoricalSample = Pick<Report, 'input' | 'runId' | 'configurationDigest' | 'coverage' | 'stages' | 'findings'> & {
  caseId: string; arm: Arm; elapsedMs: number; verifiedEvidence: string[];
};
export interface HistoricalAdjudication {
  caseId: string; arm: Arm; findingId: string; labelId: string | null; reviewer: string; reason: string;
}

export const historicalConfigurations: Record<Arm, LocalConfig> = {
  semgrep: { ...localAnalysisBaseline, adapter: 'historical-git-v1' },
  'semgrep-plus-cross-file': { ...githubConfig, adapter: 'historical-git-v1' },
};

export function historicalInput(item: HistoricalCase): ReviewInput {
  // The fixture source selects the offline snapshot path. The corpus records the public upstream repository.
  return inputSchema.parse({ source: 'fixture', repositoryId: item.repository, pullRequestNumber: item.number, baseSha: item.baseSha, headSha: item.headSha });
}

export async function loadHistoricalDataset() {
  const directory = new URL('../../../fixtures/historical/', import.meta.url);
  const [bytes, sealBytes] = await Promise.all([readFile(new URL('cases.json', directory)), readFile(new URL('seal.json', directory))]);
  const seal = JSON.parse(sealBytes.toString()) as { casesSha256: string };
  if (createHash('sha256').update(bytes).digest('hex') !== seal.casesSha256) throw new Error('Historical corpus differs from its reservation');
  const dataset = JSON.parse(bytes.toString()) as HistoricalDataset;
  const repositories = new Set(dataset.cases.map(item => item.repository));
  if (dataset.version !== 1 || dataset.split !== 'held-out' || repositories.size < 2 ||
      repositories.size !== dataset.repositories.length || !dataset.repositories.every(repository => repositories.has(repository)) ||
      new Set(dataset.cases.map(item => item.id)).size !== dataset.cases.length ||
      new Set(dataset.cases.map(item => digest(historicalInput(item)))).size !== dataset.cases.length ||
      (dataset.labelReview.status === 'reviewed' && !dataset.labelReview.independentReviewer?.trim())) throw new Error('Invalid repository-level reservation');
  for (const item of dataset.cases) {
    if (!item.labels.length && !item.cleanBehavior?.trim()) throw new Error('Missing clean behavior label');
    if (new Set(item.labels.map(label => label.id)).size !== item.labels.length) throw new Error('Duplicate historical label');
    for (const label of item.labels) {
      if (!label.expected.trim() || !label.evidence.length ||
          !label.evidence.every(range => range.startLine > 0 && range.endLine >= range.startLine) ||
          !dataset.cases.some(fix => fix.repository === item.repository && !fix.labels.length && fix.headSha === label.fixSha && fix.reference === label.fix)) {
        throw new Error('Historical defect requires evidence and a reserved upstream fix');
      }
    }
  }
  return { ...dataset, seal };
}

export async function verifiedFindings(report: Report, adapter: RepositoryAdapter) {
  if (!report.findings.length) return [];
  const changes = await adapter.changedFiles(report.input.baseSha, report.input.headSha);
  const verified: string[] = [];
  for (const finding of report.findings) {
    const proof = finding.evidence;
    const change = changes.find(file => file.path === proof.path);
    if (!change || proof.revision !== report.input.headSha) continue;
    const source = await adapter.fileAt(proof.revision, proof.path);
    if (!validAnchor({ path: proof.path, source, change }, proof)) continue;
    let valid = true;
    for (const citation of finding.citations ?? []) {
      const evidence = citation.evidence;
      const revision = citation.role === 'base-return' ? report.input.baseSha : report.input.headSha;
      if (evidence.revision !== revision) { valid = false; break; }
      const text = await adapter.fileAt(revision, evidence.path);
      const lines = text.split('\n');
      if (evidence.endLine < evidence.startLine || evidence.endLine > lines.length ||
          lines.slice(evidence.startLine - 1, evidence.endLine).join('\n') !== evidence.excerpt) { valid = false; break; }
    }
    if (valid) verified.push(finding.id);
  }
  return verified;
}

export function scoreHistorical(cases: HistoricalCase[], samples: HistoricalSample[], adjudications: HistoricalAdjudication[] = []) {
  const sampleKeys = new Set<string>();
  const decisions = new Map<string, HistoricalAdjudication>();
  const key = ({ caseId, arm, findingId }: Pick<HistoricalAdjudication, 'caseId' | 'arm' | 'findingId'>) => `${caseId}/${arm}/${findingId}`;
  for (const decision of adjudications) {
    if (decisions.has(key(decision)) || !decision.reviewer.trim() || !decision.reason.trim()) throw new Error('Invalid or duplicate historical adjudication');
    decisions.set(key(decision), decision);
  }
  const rows = samples.map(sample => {
    const { caseId, arm, coverage, runId, elapsedMs } = sample;
    if (sampleKeys.has(`${caseId}/${arm}`) || !historicalArms.includes(arm) || !Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid or duplicate historical sample');
    sampleKeys.add(`${caseId}/${arm}`);
    const item = cases.find(item => item.id === caseId);
    if (!item || digest(sample.input) !== digest(historicalInput(item)) ||
        sample.configurationDigest !== runIdentity(sample.input, historicalConfigurations[arm]).configurationDigest) throw new Error('Historical sample identity changed');
    const matches: { labelId: string; findingId: string }[] = [];
    const falseFindings: string[] = [], unadjudicated: string[] = [];
    for (const finding of sample.findings) {
      const id = key({ caseId, arm, findingId: finding.id });
      const decision = decisions.get(id);
      decisions.delete(id);
      if (!sample.verifiedEvidence.includes(finding.id) || decision?.labelId === null) {
        falseFindings.push(finding.id);
        continue;
      }
      if (!decision) { unadjudicated.push(finding.id); continue; }
      const label = item.labels.find(label => label.id === decision.labelId && label.evidence.some(range =>
        range.path === finding.evidence.path && range.startLine <= finding.evidence.startLine && range.endLine >= finding.evidence.endLine));
      if (!label) throw new Error('Adjudication outside the reserved evidence ranges');
      if (matches.some(match => match.labelId === label.id)) falseFindings.push(finding.id);
      else matches.push({ labelId: label.id, findingId: finding.id });
    }
    return { caseId, arm, runId, elapsedMs, coverage: coverage.status, matches, falseFindings, unadjudicated,
      missed: item.labels.filter(label => !matches.some(match => match.labelId === label.id)).map(label => label.id),
      cleanFlagged: !item.labels.length && sample.findings.length > 0 };
  });
  if (decisions.size || rows.length !== cases.length * historicalArms.length) throw new Error('Historical scoring requires both arms for every case and decisions tied to actual findings');
  const baseline = new Set(rows.filter(row => row.arm === 'semgrep').flatMap(row => row.matches.map(match => `${row.caseId}/${match.labelId}`)));
  const arms = historicalArms.map(arm => {
    const selected = rows.filter(row => row.arm === arm);
    const sum = (count: (row: typeof selected[number]) => number) => selected.reduce((total, row) => total + count(row), 0);
    return { arm, comparisons: selected.length, labeledDefects: cases.reduce((n, item) => n + item.labels.length, 0),
      verifiedDefects: sum(row => row.matches.length),
      additionalVerifiedDefects: sum(row => row.matches.filter(match => !baseline.has(`${row.caseId}/${match.labelId}`)).length),
      missedDefects: sum(row => row.missed.length),
      missesOnPartialScans: sum(row => row.coverage === 'complete' ? 0 : row.missed.length),
      findings: sum(row => row.matches.length + row.falseFindings.length + row.unadjudicated.length),
      falseFindings: sum(row => row.falseFindings.length),
      unadjudicatedFindings: sum(row => row.unadjudicated.length),
      cleanComparisons: cases.filter(item => !item.labels.length).length,
      cleanComparisonsFlagged: selected.filter(row => row.cleanFlagged).length,
      incompleteScans: selected.filter(row => row.coverage !== 'complete').length,
      p50Ms: percentile(selected.map(row => row.elapsedMs), .5), p95Ms: percentile(selected.map(row => row.elapsedMs), .95),
    };
  });
  return { rows, arms };
}
