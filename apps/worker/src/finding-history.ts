import { randomUUID } from 'node:crypto';
import { decisionInputSchema, findingDecisionSchema, reportSchema, type Finding, type FindingHistory, type FindingHistoryEntry, type Report } from '@opticpr/contracts';
import { Prisma, type PrismaClient } from '@opticpr/database';
import { digest } from '@opticpr/runtime';

type Tx = Prisma.TransactionClient;
type Decision = NonNullable<FindingHistoryEntry['decision']>;

export async function previousFindingSnapshot(db: Tx | PrismaClient, run: { id: string; source: string; repositoryId: string; pullRequestNumber: number; createdAt: Date }) {
  return db.findingSnapshot.findFirst({ where: {
    run: { source: run.source, repositoryId: run.repositoryId, pullRequestNumber: run.pullRequestNumber,
      OR: [{ createdAt: { lt: run.createdAt } }, { createdAt: run.createdAt, id: { lt: run.id } }] },
  }, orderBy: [{ run: { createdAt: 'desc' } }, { runId: 'desc' }] });
}

export async function lockFindingHistory(tx: Tx, source: string, repositoryId: string, number: number) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`history:${source}:${repositoryId}:${number}`}, 0))::text`;
}

function sameCondition(a: Finding, b: Finding) {
  return !!a.identity && !!b.identity && a.identity.class === b.identity.class &&
    a.identity.expression === b.identity.expression && a.identity.symbol === b.identity.symbol;
}
function mappedPath(report: Report, path: string): string | undefined {
  const renames = report.comparison?.filter(change => change.status === 'renamed' && change.previousPath === path) ?? [];
  if (renames.length > 1) return;
  return renames.length === 1 ? renames[0]!.path : path;
}
function agrees(report: Report, current: Finding, old: Finding) {
  return mappedPath(report, old.evidence.path) === current.evidence.path && sameCondition(current, old);
}

/** Sources agree only at the same exact anchor and semantic condition. Repeated
 * expressions at different locations remain separate candidates for ambiguity checks. */
export function groupFindings(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding>();
  for (const raw of findings) {
    const finding = structuredClone(raw);
    const key = digest({ identity: finding.identity ? { class: finding.identity.class, expression: finding.identity.expression, symbol: finding.identity.symbol } : finding.ruleId, evidence: finding.evidence });
    const previous = groups.get(key);
    if (!previous) { groups.set(key, finding); continue; }
    const citations = [...(previous.citations ?? []), ...(finding.citations ?? [])];
    const representative = previous.identity?.kind === 'model' && finding.identity?.kind === 'static' ? finding : previous;
    representative.citations = [...new Map(citations.map(citation => [digest(citation), citation])).values()];
    groups.set(key, representative);
  }
  return [...groups.values()];
}

/** Pure one-to-one matching. No nearest-line heuristic can transfer a dismissal. */
export function compareFindings(report: Report, previous?: Report, decisions: Decision[] = []): { history: FindingHistory; findings: Finding[] } {
  const prior = previous?.history?.findings ?? [];
  const anchored = groupFindings(report.findings);
  // Full-file matches outside the diff may confirm an existing finding, but may
  // never introduce a new finding outside the reviewed changed lines.
  const supplemental = (report.recheck?.observations ?? []).filter(finding =>
    prior.some(old => agrees(report, finding, old.lastObservation)) && !anchored.some(item => item.id === finding.id));
  const current = groupFindings([...anchored, ...supplemental]);
  const edges = current.map(finding => prior.flatMap((old, index) => agrees(report, finding, old.lastObservation) ? [index] : []));
  const degree = prior.map((_, index) => edges.filter(matches => matches.includes(index)).length);
  const linked = new Set<number>();
  const entries: FindingHistoryEntry[] = [];
  const findings: Finding[] = [];
  for (const [index, observation] of current.entries()) {
    const matches = edges[index]!;
    const oldIndex = matches.length === 1 && degree[matches[0]!] === 1 ? matches[0] : undefined;
    const old = oldIndex === undefined ? undefined : prior[oldIndex];
    if (oldIndex !== undefined) linked.add(oldIndex);
    const findingId = old?.findingId ?? randomUUID();
    observation.id = findingId;
    const decision = old ? decisions.filter(item => item.findingId === findingId).at(-1) ?? old.decision : undefined;
    entries.push({ findingId, state: old ? 'still_present' : matches.length ? 'needs_verification' : 'new',
      reason: old ? 'Unambiguous condition, enclosing symbol and file mapping.' : matches.length ? 'Multiple plausible observations; no identity or decision transferred.' : 'First observation of this condition.',
      ...(old ? { previous: { runId: old.lastObservedRunId, findingId } } : {}),
      observation, lastObservation: observation, lastObservedRunId: report.runId,
      lastObservedConfigurationDigest: report.configurationDigest, ...(decision ? { decision } : {}),
    });
    findings.push(observation);
  }
  for (const [index, old] of prior.entries()) {
    if (linked.has(index)) continue;
    const proof = old.lastObservation;
    const path = mappedPath(report, proof.evidence.path);
    const recheck = report.recheck;
    const deterministic = proof.identity?.kind === 'static' || proof.identity?.kind === 'fixture';
    const clear = degree[index] === 0 && deterministic && old.lastObservedConfigurationDigest === report.configurationDigest &&
      !!path && !!recheck?.completed && recheck.files.includes(path) && recheck.rules.includes(proof.ruleId) &&
      // A parse failure or filtered result must never masquerade as rule absence.
      !recheck.observations.some(item => item.evidence.path === path && item.ruleId === proof.ruleId && !item.identity);
    entries.push({ findingId: old.findingId, state: clear ? 'cleared_by_recheck' : 'needs_verification',
      reason: clear ? 'Same deterministic rule and configuration fully rechecked the affected file; condition absent.' :
        degree[index] ? 'Multiple plausible matches; previous evidence retained.' : 'No complete equivalent deterministic recheck; previous evidence retained.',
      previous: { runId: old.lastObservedRunId, findingId: old.findingId }, lastObservation: proof, lastObservedRunId: old.lastObservedRunId,
      lastObservedConfigurationDigest: old.lastObservedConfigurationDigest,
    });
  }
  return { history: { previousRunId: previous?.runId ?? null, findings: entries }, findings };
}

/** Called inside report completion, after the PR lock. Snapshot and report commit
 * together. Ordering by queued time prevents a late worker from comparing to a
 * newer revision. Completed snapshots are never rewritten, including on retry. */
export async function snapshotFindingHistory(tx: Tx, raw: Report): Promise<Report> {
  const report = reportSchema.parse(raw);
  const { source, repositoryId, pullRequestNumber } = report.input;
  await lockFindingHistory(tx, source, repositoryId, pullRequestNumber);
  const existing = await tx.findingSnapshot.findUnique({ where: { runId: report.runId } });
  if (existing) return reportSchema.parse(existing.report);
  const run = await tx.reviewRun.findUniqueOrThrow({ where: { id: report.runId } });
  const previous = await previousFindingSnapshot(tx, run);
  const previousReport = previous ? reportSchema.parse(previous.report) : undefined;
  const ids = previousReport?.history?.findings.map(item => item.findingId) ?? [];
  const decisions = (await tx.findingDecision.findMany({ where: { findingId: { in: ids } }, orderBy: { sequence: 'asc' } }))
    .map(item => findingDecisionSchema.parse({ ...item, createdAt: item.createdAt.toISOString() }));
  const compared = compareFindings(report, previousReport, decisions);
  report.history = compared.history; report.findings = compared.findings;
  for (const entry of report.history.findings) {
    if (entry.previous) continue;
    await tx.finding.create({ data: { id: entry.findingId, source, repositoryId, pullRequestNumber } });
  }
  await tx.findingSnapshot.create({ data: { runId: report.runId, report: report as Prisma.InputJsonValue } });
  return report;
}

export { appendFindingDecision } from '@opticpr/runtime';
