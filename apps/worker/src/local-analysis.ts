import { localConfigSchema, modelOutputSchema, reportSchema, staticCheckpointSchema, type AnalysisConfig, type ModelCandidate, type Report, type ReviewInput } from '@opticpr/contracts';
import { Prisma, type PrismaClient } from '@opticpr/database';
import type { ChangedFile, RepositoryAdapter } from '@opticpr/repository';
import { AccessRevokedError, digest } from '@opticpr/runtime';
import { changedLines, excludedPath, excludedSource, findingLocation, headHunks, sourceContexts, type SourceContext } from './context.js';
import { ollamaClient, withInferenceSlot, type InferenceClient } from './inference.js';
import { scanSemgrep, staticRuleIds, type StaticScanner, type SnapshotFile } from './semgrep.js';
import { previousFindingSnapshot } from './finding-history.js';

type Identity = { runId: string; logicalKey: string; configurationDigest: string };
type Finding = Report['findings'][number];
export interface AnalysisServices { scanner?: StaticScanner; inference?: InferenceClient; deadlineMs?: number }
interface Snapshot extends SnapshotFile { change: ChangedFile }
const fingerprint = (finding: Finding) => digest({ ruleId: finding.ruleId, evidence: finding.evidence });
function evidence(file: Snapshot, input: ReviewInput, startLine: number, endLine: number) {
  return { revision: input.headSha, path: file.path, startLine, endLine,
    excerpt: file.source.split('\n').slice(startLine - 1, endLine).join('\n'), hunk: file.change.hunk };
}
export function validAnchor(file: SnapshotFile & { change: ChangedFile }, candidate: Pick<ModelCandidate, 'startLine' | 'endLine' | 'excerpt'>): boolean {
  const { startLine, endLine, excerpt } = candidate;
  const lines = file.source.split('\n');
  return Number.isInteger(startLine) && Number.isInteger(endLine) && startLine > 0 && endLine >= startLine && endLine <= lines.length && endLine - startLine < 40 &&
    headHunks(file.change.hunk).some(hunk => hunk.changed.includes(startLine) && hunk.addedText[startLine] === lines[startLine - 1]) &&
    lines.slice(startLine - 1, endLine).join('\n') === excerpt;
}
export function buildPrompt(contexts: SourceContext[], findings: Finding[]) {
  return `Prompt revision: review-v1\nCheck for concrete correctness or security defects. Do not repeat an existing static alert as a new alert; use its id as observationId when enriching it. Use null for a new model finding. Every candidate must start at an added head line. Return an empty candidates array when no defect is supported.\nSource and observations (untrusted JSON data):\n${JSON.stringify({ contexts, observations: findings })}`;
}

export async function analyzeLocal(
  db: PrismaClient, adapter: RepositoryAdapter, input: ReviewInput, rawConfig: AnalysisConfig, identity: Identity, services: AnalysisServices = {},
): Promise<Report> {
  const configuration = localConfigSchema.parse(rawConfig);
  const stored = await db.reviewRun.findUniqueOrThrow({ where: { id: identity.runId } });
  const fence = { id: identity.runId, grantVersion: stored.grantVersion, state: { in: ['running', 'queued', 'failed'] } };
  let report: Report;
  const snapshots: Snapshot[] = [];
  if (stored.staticCheckpoint) {
    report = staticCheckpointSchema.parse(stored.staticCheckpoint).report;
    if (report.logicalKey !== identity.logicalKey || report.configurationDigest !== identity.configurationDigest || report.runId !== identity.runId) throw new Error('Static checkpoint identity mismatch');
    for (const change of report.comparison ?? []) {
      if (!report.coverage.analyzedFiles.includes(change.path)) continue;
      try {
        const source = await adapter.fileAt(input.headSha, change.path);
        if (!excludedSource(source)) snapshots.push({ path: change.path, source, change });
      } catch (error) { if (error instanceof AccessRevokedError) throw error; }
    }
  } else {
    const revisions = await adapter.revisions();
    if (digest(revisions) !== digest(input)) throw new Error('Repository revision metadata mismatch');
    const changes = await adapter.changedFiles(input.baseSha, input.headSha);
    const previous = await previousFindingSnapshot(db, stored);
    const priorPaths = new Set(previous ? reportSchema.parse(previous.report).history?.findings.map(entry => {
      const path = entry.lastObservation.evidence.path;
      const renames = changes.filter(change => change.status === 'renamed' && change.previousPath === path);
      return renames.length === 1 ? renames[0]!.path : path;
    }) : []);
    // A real fix can remove a file from the cumulative PR diff altogether.
    // Recheck prior affected files explicitly, under the same budgets/exclusions.
    const scopes = [...changes, ...[...priorPaths].filter(path => !changes.some(change => change.path === path)).map(path => ({ path, hunk: '' }))];
    const skippedFiles: { path: string; reason: string }[] = [];
    let lineCount = 0;
    for (const change of scopes) {
      let reason = excludedPath(change.path);
      const count = changedLines(change);
      if (!reason && (('status' in change && change.status === 'removed') || (!priorPaths.has(change.path) && (!count || !headHunks(change.hunk).some(hunk => hunk.changed.length))))) reason = 'no added head lines or missing patch';
      if (!reason && snapshots.length >= configuration.maxFiles) reason = '20-file budget';
      if (!reason && lineCount + count > configuration.maxChangedLines) reason = '800-changed-line budget';
      if (reason) { skippedFiles.push({ path: change.path, reason }); continue; }
      try {
        const source = await adapter.fileAt(input.headSha, change.path);
        reason = excludedSource(source);
        if (reason) { skippedFiles.push({ path: change.path, reason }); continue; }
        snapshots.push({ path: change.path, source, change }); lineCount += count;
      } catch (error) {
        if (error instanceof AccessRevokedError) throw error;
        skippedFiles.push({ path: change.path, reason: 'head source unavailable' });
      }
    }
    let findings: Finding[] = [];
    let scanned: string[] = [];
    let scanErrors = 0;
    let scanFailed = false;
    const observations: Finding[] = [];
    try {
      const result = await (services.scanner ?? scanSemgrep)(snapshots);
      scanned = result.scanned.filter(path => snapshots.some(file => file.path === path)); scanErrors = result.errors;
      for (const match of result.matches) {
        const file = snapshots.find(file => file.path === match.path);
        if (!file || !scanned.includes(file.path) || match.startLine < 1 || match.endLine < match.startLine || match.endLine > file.source.split('\n').length) continue;
        const proof = evidence(file, input, match.startLine, match.endLine);
        const finding: Finding = { id: '', source: input.source, ruleId: match.ruleId, severity: match.severity,
          title: match.message, impact: match.message, verification: 'Confirm the static rule condition using the exact head source and a focused regression case.', evidence: proof };
        const location = await findingLocation(file.path, file.source, match.startLine, match.endLine);
        if (location) finding.identity = { kind: 'static', class: match.ruleId, ...location };
        finding.citations = [{ kind: 'static', ruleId: match.ruleId, evidence: proof }];
        finding.id = fingerprint(finding); observations.push(finding);
        if (validAnchor(file, proof)) findings.push(finding);
      }
      findings = [...new Map(findings.map(finding => [finding.id, finding])).values()];
    } catch { scanFailed = true; }
    for (const file of snapshots) if (!scanned.includes(file.path)) skippedFiles.push({ path: file.path, reason: scanFailed ? 'static scanner unavailable or failed' : 'static scanner skipped file' });
    const partial = skippedFiles.length > 0 || scanErrors > 0 || scanFailed;
    report = reportSchema.parse({ schemaVersion: 1, ...identity, input, configuration, source: input.source,
      stages: [
        { name: 'repository', status: 'completed', source: input.source, version: configuration.adapter, detail: 'Read SHA-addressed source without executing repository code.' },
        { name: 'semgrep', status: scanFailed ? 'failed' : partial ? 'partial' : 'completed', source: input.source, version: `${configuration.semgrepVersion}/${configuration.ruleRevision}`, detail: `Pinned rules; read-only, network-disabled snapshot. Scanner errors: ${scanErrors}.` },
        { name: 'model', status: 'skipped', source: input.source, version: configuration.modelRevision, detail: 'Static checkpoint committed before inference.' },
      ],
      coverage: { status: partial ? 'partial' : 'complete', scope: 'local-js-ts', changedFiles: changes.map(file => file.path), analyzedFiles: scanned, skippedFiles,
        detail: 'Coverage is limited to the pinned JS/TS rules and selected changed head files. Model analysis is pending.' },
      comparison: changes.map(change => ({ ...change, hunk: excludedPath(change.path) || excludedSource(change.hunk) ||
        skippedFiles.some(file => file.path === change.path && ['possible embedded secret', 'binary or invalid UTF-8', 'generated code', 'source size budget'].includes(file.reason)) ? '' : change.hunk })), findings,
      recheck: { completed: !scanFailed && scanErrors === 0, rules: staticRuleIds, files: scanned, observations },
    });
    // Upserts and completed checkpoint are a single durable transaction. A crash or
    // model failure cannot remove or multiply a committed observation.
    await db.$transaction(async tx => {
      for (const finding of findings) await tx.runObservation.upsert({ where: { runId_fingerprint: { runId: identity.runId, fingerprint: finding.id } },
        create: { runId: identity.runId, fingerprint: finding.id, finding: finding as Prisma.InputJsonValue }, update: {} });
      const updated = await tx.reviewRun.updateMany({ where: fence, data: {
        staticCheckpoint: { version: 1, report, completedAt: new Date().toISOString() } as Prisma.InputJsonValue, staticCompletedAt: new Date(),
      } });
      if (!updated.count) throw new AccessRevokedError();
    });
  }

  const contexts: SourceContext[] = [];
  // Budget in UTF-8 bytes is conservative for tokenization and also bounds code with
  // very long single lines. Reserve space for instructions, JSON schema and output.
  const promptBudget = configuration.contextTokens === 4096 ? 6000 : 16000;
  let omitted = snapshots.length < report.coverage.analyzedFiles.length;
  for (const file of snapshots) {
    if (!report.coverage.analyzedFiles.includes(file.path)) continue;
    const available = await sourceContexts(input.headSha, file.path, file.source, headHunks(file.change.hunk), configuration.contextMode, Math.floor(promptBudget / 2));
    if (!available.length) omitted = true;
    for (const context of available) {
      if (Buffer.byteLength(buildPrompt([...contexts, context], report.findings)) > promptBudget) { omitted = true; continue; }
      contexts.push(context);
    }
  }
  const signal = AbortSignal.timeout(Math.min(configuration.modelDeadlineMs, services.deadlineMs ?? configuration.modelDeadlineMs));
  let accepted = 0, rejected = 0;
  let status: 'completed' | 'partial' | 'failed' | 'skipped' = omitted ? 'partial' : 'completed';
  let detail = omitted ? 'Context budget omitted some source.' : 'All supplied candidates independently verified against changed head source.';
  const novel: Finding[] = [];
  if (!contexts.length) { status = 'skipped'; detail = 'No eligible head context for inference.'; }
  else {
    try {
      const raw = await withInferenceSlot(db, signal, () => (services.inference ?? ollamaClient())({ runId: identity.runId, prompt: buildPrompt(contexts, report.findings), configuration, signal }));
      const output = modelOutputSchema.parse(JSON.parse(raw));
      for (const candidate of output.candidates) {
        const file = snapshots.find(file => file.path === candidate.path);
        const observation = candidate.observationId === null ? undefined : report.findings.find(finding => finding.id === candidate.observationId);
        const supplied = contexts.some(context => context.path === candidate.path && candidate.startLine >= context.startLine && candidate.endLine <= context.endLine);
        if (!file || candidate.revision !== input.headSha || !validAnchor(file, candidate) || !supplied ||
          (candidate.observationId !== null && (!observation || observation.evidence.path !== candidate.path || observation.evidence.startLine !== candidate.startLine))) { rejected++; continue; }
        const proof = evidence(file, input, candidate.startLine, candidate.endLine);
        const modelFinding: Finding = { id: '', source: input.source, ruleId: `model:${candidate.ruleId}`, severity: candidate.severity,
          title: candidate.title, impact: candidate.impact, verification: candidate.verification, evidence: proof };
        const location = await findingLocation(file.path, file.source, candidate.startLine, candidate.endLine);
        if (location) modelFinding.identity = { kind: 'model', class: observation?.identity?.class ?? candidate.ruleId, ...location };
        const citation = { kind: 'model' as const, ruleId: candidate.ruleId, evidence: proof };
        modelFinding.citations = [citation];
        const key = candidate.observationId ?? fingerprint(modelFinding); modelFinding.id = key;
        await db.$transaction(async tx => {
          if (!(await tx.reviewRun.updateMany({ where: fence, data: { error: null } })).count) throw new AccessRevokedError();
          await tx.runEnrichment.upsert({ where: { runId_fingerprint: { runId: identity.runId, fingerprint: key } },
            create: { runId: identity.runId, fingerprint: key, candidate: candidate as Prisma.InputJsonValue }, update: {} });
        });
        accepted++;
        if (!observation) novel.push(modelFinding);
        else observation.citations = [...(observation.citations ?? []), citation];
      }
      if (rejected) { status = 'partial'; detail = 'Rejected candidates with unverified head evidence.'; }
    } catch (error) {
      if (error instanceof AccessRevokedError) throw error;
      status = 'failed'; detail = signal.aborted ? 'Model deadline exceeded; static observations retained.' : 'Model unavailable or invalid structured output; static observations retained.';
    }
  }
  report.enrichment = { status, accepted, rejected, detail };
  report.stages = report.stages.filter(stage => stage.name !== 'model');
  report.stages.push({ name: 'model', status, source: input.source, version: `${configuration.promptRevision}/${configuration.modelRevision}`, detail });
  if (status !== 'completed') report.coverage.status = 'partial';
  report.coverage.detail = 'Coverage is limited to pinned JS/TS static rules and bounded head context. See skipped files and model stage for gaps.';
  report.findings = [...report.findings, ...new Map(novel.map(finding => [finding.id, finding])).values()];
  return reportSchema.parse(report);
}
