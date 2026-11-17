import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { fixtureConfig, type Report } from '../packages/contracts/src/index.js';
import { FixtureRepositoryAdapter } from '../packages/repository/src/index.js';
import { runIdentity } from '../packages/runtime/src/index.js';
import { analyzeFixture } from '../apps/worker/src/analyze.js';
import { findingLocation } from '../apps/worker/src/context.js';
import { compareFindings, groupFindings } from '../apps/worker/src/finding-history.js';

let adapter: FixtureRepositoryAdapter;
let template: Report;
beforeAll(async () => {
  adapter = await FixtureRepositoryAdapter.open();
  const input = await adapter.revisions();
  template = await analyzeFixture(adapter, input, fixtureConfig, { runId: randomUUID(), ...runIdentity(input, fixtureConfig) });
});
afterAll(async () => { await adapter?.close(); });
function snapshot() {
  const report = structuredClone(template);
  const compared = compareFindings(report);
  report.history = compared.history; report.findings = compared.findings;
  return report;
}
function next(previous: Report) {
  const report = structuredClone(previous); report.runId = randomUUID(); delete report.history;
  return report;
}
it('normalizes tokens and enclosing symbols without erasing string contents or operators', async () => {
  const a = await findingLocation('a.ts', 'function run() {\n  eval("a b");\n}', 2, 2);
  const b = await findingLocation('a.ts', '// header\nfunction run() {\n eval ( "a b" ); // comment\n}', 3, 3);
  expect(a).toEqual(b);
  expect(a?.symbol).toBe('run');
  expect(await findingLocation('a.ts', 'function run() {\n eval("ab");\n}', 2, 2)).not.toEqual(a);
  expect(await findingLocation('a.ts', 'function other() {\n eval("a b");\n}', 2, 2)).not.toEqual(a);
  expect(await findingLocation('a.ts', 'function () !!!', 1, 1)).toBeUndefined();
});
it('retains a stable identity and decision only through one-to-one line moves and clear renames', () => {
  const previous = snapshot(), current = next(previous);
  const entry = previous.history!.findings[0]!;
  const decision = { id: randomUUID(), runId: previous.runId, findingId: entry.findingId, action: 'dismiss' as const, actor: 'maintainer', reason: 'Known test case', createdAt: new Date().toISOString() };
  current.findings[0]!.evidence.startLine += 10;
  current.findings[0]!.evidence.path = 'src/pages.ts';
  current.comparison = [{ path: 'src/pages.ts', previousPath: 'src/paginate.ts', status: 'renamed', hunk: '' }];
  const result = compareFindings(current, previous, [decision]);
  expect(result.history.findings[0]).toMatchObject({ findingId: entry.findingId, state: 'still_present', decision });
  expect(result.findings[0]!.id).toBe(entry.findingId);
  expect(previous.history!.findings[0]!.lastObservation.evidence.startLine).toBe(3);
  delete current.comparison;
  expect(compareFindings(current, previous, [decision]).history.findings.find(item => item.findingId === entry.findingId)).toMatchObject({ state: 'needs_verification' });
});
it.each(['skip', 'configuration', 'model', 'scanner-error', 'missing-rule', 'unparsed-match'] as const)('does not clear on %s', mode => {
  const previous = snapshot(), current = next(previous);
  current.findings = [];
  current.recheck = { completed: true, files: ['src/paginate.ts'], rules: [template.findings[0]!.ruleId], observations: [] };
  if (mode === 'skip') current.recheck.files = [];
  if (mode === 'configuration') current.configurationDigest = 'f'.repeat(64);
  if (mode === 'model') previous.history!.findings[0]!.lastObservation.identity!.kind = 'model';
  if (mode === 'scanner-error') current.recheck.completed = false;
  if (mode === 'missing-rule') current.recheck.rules = [];
  if (mode === 'unparsed-match') { const finding = structuredClone(template.findings[0]!); delete finding.identity; current.recheck.observations = [finding]; }
  const result = compareFindings(current, previous);
  expect(result.history.findings).toHaveLength(1);
  expect(result.history.findings[0]).toMatchObject({ state: 'needs_verification', lastObservedRunId: previous.runId });
});
it('clears only after a complete equivalent rule recheck, retaining the previous exact citation', () => {
  const previous = snapshot(), current = next(previous);
  current.findings = [];
  current.recheck = { completed: true, files: ['src/paginate.ts'], rules: [template.findings[0]!.ruleId], observations: [] };
  const result = compareFindings(current, previous);
  expect(result.history.findings[0]).toMatchObject({ state: 'cleared_by_recheck', lastObservation: previous.findings[0], lastObservedRunId: previous.runId });
  expect(result.history.findings[0]!.observation).toBeUndefined();
});
it('keeps the original observation configuration across multiple incomplete snapshots', () => {
  const previous = snapshot(), changed = next(previous);
  changed.findings = []; changed.configurationDigest = 'f'.repeat(64);
  changed.recheck = { completed: true, files: ['src/paginate.ts'], rules: [template.findings[0]!.ruleId], observations: [] };
  const result = compareFindings(changed, previous); changed.history = result.history;
  const repeated = next(changed);
  expect(compareFindings(repeated, changed).history.findings[0]!.state).toBe('needs_verification');
});
it('restores an audited decision after an incomplete check only when the observation matches unambiguously', () => {
  const previous = snapshot(), incomplete = next(previous);
  const decision = { id: randomUUID(), runId: previous.runId, findingId: previous.findings[0]!.id, action: 'dismiss' as const, actor: 'raj', reason: 'Accepted', createdAt: new Date().toISOString() };
  incomplete.findings = []; incomplete.history = compareFindings(incomplete, previous, [decision]).history;
  expect(incomplete.history.findings[0]!.decision).toBeUndefined();
  const restored = next(incomplete); restored.findings = structuredClone(previous.findings);
  const result = compareFindings(restored, incomplete, [decision]);
  expect(result.history.findings[0]).toMatchObject({ state: 'still_present', decision, previous: { runId: previous.runId } });
});
it('treats one-to-many and many-to-one matches as ambiguous without inheriting decisions', () => {
  const previous = snapshot(), current = next(previous);
  previous.history!.findings[0]!.decision = { id: randomUUID(), findingId: previous.findings[0]!.id, runId: previous.runId, action: 'dismiss', actor: 'a', reason: 'r', createdAt: new Date().toISOString() };
  current.findings.push(structuredClone(current.findings[0]!)); current.findings[1]!.evidence.startLine++;
  const result = compareFindings(current, previous);
  expect(result.history.findings).toHaveLength(3);
  expect(result.history.findings.every(item => item.state === 'needs_verification' && !item.decision)).toBe(true);
  const other = structuredClone(previous.history!.findings[0]!); other.findingId = randomUUID();
  previous.history!.findings.push(other);
  current.findings.pop();
  expect(compareFindings(current, previous).history.findings.every(item => item.state === 'needs_verification')).toBe(true);
});
it('groups agreeing sources at one anchor and keeps both citations', () => {
  const staticFinding = structuredClone(template.findings[0]!);
  staticFinding.identity!.kind = 'static'; staticFinding.citations = [{ kind: 'static', ruleId: staticFinding.ruleId, evidence: staticFinding.evidence }];
  const model = structuredClone(staticFinding); model.identity!.kind = 'model'; model.ruleId = 'model:boundary';
  model.citations = [{ kind: 'model', ruleId: model.ruleId, evidence: model.evidence }];
  const grouped = groupFindings([staticFinding, model]);
  expect(grouped).toHaveLength(1); expect(grouped[0]!.citations).toHaveLength(2);
  expect(groupFindings([model, staticFinding])[0]!.identity!.kind).toBe('static');
});
it('uses a full-file observation to confirm a prior finding outside added diff lines', () => {
  const previous = snapshot(), current = next(previous);
  current.recheck = { completed: true, rules: [current.findings[0]!.ruleId], files: ['src/paginate.ts'], observations: current.findings };
  current.findings = [];
  expect(compareFindings(current, previous).history.findings[0]!.state).toBe('still_present');
});
