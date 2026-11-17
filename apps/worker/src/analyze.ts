import { reportSchema, type AnalysisConfig, type Report, type ReviewInput } from '@opticpr/contracts';
import type { RepositoryAdapter } from '@opticpr/repository';

/** Pinned synthetic result, deliberately distinct from a Semgrep/model finding. */
export async function analyzeFixture(
  adapter: RepositoryAdapter, input: ReviewInput, configuration: AnalysisConfig,
  identity: { runId: string; logicalKey: string; configurationDigest: string },
): Promise<Report> {
  const revisions = await adapter.revisions();
  if (revisions.baseSha !== input.baseSha || revisions.headSha !== input.headSha ||
      revisions.repositoryId !== input.repositoryId || revisions.pullRequestNumber !== input.pullRequestNumber) {
    throw new Error('Fixture revision metadata mismatch');
  }
  const changes = await adapter.changedFiles(input.baseSha, input.headSha);
  const changed = changes[0];
  if (changes.length !== 1 || changed?.path !== 'src/paginate.ts') throw new Error('Unsupported fixture coverage');
  const [base, head] = await Promise.all([
    adapter.fileAt(input.baseSha, changed.path), adapter.fileAt(input.headSha, changed.path),
  ]);
  const boundary = '  const end = start + pageSize - 1;';
  const line = head.split('\n').indexOf(boundary) + 1;
  if (!base.includes('  const end = start + pageSize;') || line === 0 || !head.includes('return items.slice(start, end);')) {
    throw new Error('Known pagination boundary is absent; refusing to fabricate a fixture result');
  }
  return reportSchema.parse({
    schemaVersion: 1, ...identity, input, configuration, source: 'fixture',
    stages: [
      { name: 'repository', status: 'completed', source: 'fixture', version: configuration.adapter, detail: 'Read two real Git commits, their diff and source from the bundled repository.' },
      { name: 'analysis', status: 'completed', source: 'fixture', version: `${configuration.analyzer}@${configuration.analyzerVersion}`, detail: `Deterministic stub for ${configuration.ruleRevision}; no source execution.` },
      { name: 'semgrep', status: 'skipped', source: 'fixture', version: 'not-configured', detail: 'Static scanning is outside this slice.' },
      { name: 'model', status: 'skipped', source: 'fixture', version: 'not-configured', detail: 'No model inference or credentials used.' },
    ],
    coverage: {
      status: 'complete', scope: 'fixture-rule-only', changedFiles: changes.map(file => file.path),
      analyzedFiles: [changed.path], skippedFiles: [],
      detail: 'Complete coverage of the single synthetic pagination rule only; no general static or model analysis.',
    },
    findings: [{
      id: 'fixture-pagination-end-exclusive', source: 'fixture', ruleId: configuration.ruleRevision,
      severity: 'high', title: 'Pagination drops the final item',
      impact: 'Array.slice excludes its end index. Subtracting one drops the last item of every full page; pageSize=1 returns an empty page.',
      verification: 'For items=[1,2,3], page=1 and pageSize=3, the base returns [1,2,3] and this head returns [1,2]. For pageSize=1, expect [1] but receive [].',
      evidence: { revision: input.headSha, path: changed.path, startLine: line, endLine: line, excerpt: boundary, hunk: changed.hunk },
    }],
  });
}

/** Intake proves exact repository access. Analysis is explicitly unknown until slice 04. */
export async function analyzeGitHubIntake(
  adapter: RepositoryAdapter, input: ReviewInput, configuration: AnalysisConfig,
  identity: { runId: string; logicalKey: string; configurationDigest: string },
): Promise<Report> {
  const revisions = await adapter.revisions();
  if (revisions.source !== input.source || revisions.repositoryId !== input.repositoryId ||
      revisions.pullRequestNumber !== input.pullRequestNumber || revisions.baseSha !== input.baseSha || revisions.headSha !== input.headSha) {
    throw new Error('GitHub revision metadata mismatch');
  }
  const changes = await adapter.changedFiles(input.baseSha, input.headSha);
  return reportSchema.parse({
    schemaVersion: 1, ...identity, input, configuration, source: 'github',
    stages: [
      { name: 'repository', status: 'completed', source: 'github', version: configuration.adapter, detail: 'Fetched the comparison for the stored base and head SHAs from the selected installation repository.' },
      ...(['analysis', 'semgrep', 'model'] as const).map(name => ({ name, status: 'skipped', source: 'github', version: 'not-configured', detail: 'Analysis is not configured in the GitHub intake slice.' })),
    ],
    coverage: {
      status: 'unknown', scope: 'repository-intake-only', changedFiles: changes.map(file => file.path), analyzedFiles: [],
      skippedFiles: changes.map(file => ({ path: file.path, reason: 'Analysis is not configured' })),
      detail: 'Repository intake succeeded. No static or model analysis was performed; an empty finding list does not indicate a clean review.',
    },
    // Persist the exact diff with the report so a retarget remains inspectable by run.
    comparison: changes,
    findings: [],
  });
}
