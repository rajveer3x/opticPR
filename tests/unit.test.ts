import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureConfig, reportSchema } from '../packages/contracts/src/index.js';
import { FixtureRepositoryAdapter } from '../packages/repository/src/index.js';
import { digest, runIdentity } from '../packages/runtime/src/index.js';
import { analyzeFixture } from '../apps/worker/src/analyze.js';

let adapter: FixtureRepositoryAdapter | undefined;
afterEach(async () => { await adapter?.close(); adapter = undefined; });

describe('credential-free pagination fixture', () => {
  it('reads actual base/head commits and binds evidence to the changed head line', async () => {
    adapter = await FixtureRepositoryAdapter.open();
    const input = await adapter.revisions();
    expect(input.baseSha).toBe('c92a9a02fefb3d11bb91c60bbf60e332df13b567');
    expect(input.headSha).toBe('7c7d890027156bff7ffe4fd89356ee5234e39f57');
    const base = await adapter.fileAt(input.baseSha, 'src/paginate.ts');
    const head = await adapter.fileAt(input.headSha, 'src/paginate.ts');
    expect(base).toContain('const end = start + pageSize;');
    expect(head).toContain('const end = start + pageSize - 1;');
    // Verify the known boundary without evaluating repository code.
    const decrement = (source: string) => source.includes('pageSize - 1') ? 1 : 0;
    expect([1, 2, 3].slice(0, 3 - decrement(base))).toEqual([1, 2, 3]);
    expect([1, 2, 3].slice(0, 3 - decrement(head))).toEqual([1, 2]);
    expect([1].slice(0, 1 - decrement(head))).toEqual([]);
    const report = await analyzeFixture(adapter, input, fixtureConfig, { runId: randomUUID(), ...runIdentity(input, fixtureConfig) });
    expect(report.findings).toHaveLength(1);
    const evidence = report.findings[0]!.evidence;
    expect(evidence.revision).toBe(input.headSha);
    expect(evidence.startLine).toBe(3);
    expect(head.split('\n')[evidence.startLine - 1]).toBe(evidence.excerpt);
    expect(evidence.hunk).toContain('+  const end = start + pageSize - 1;');
    expect(report.stages.map(stage => [stage.name, stage.status])).toEqual([
      ['repository', 'completed'], ['analysis', 'completed'], ['semgrep', 'skipped'], ['model', 'skipped'],
    ]);
    expect(report.coverage).toMatchObject({ status: 'complete', scope: 'fixture-rule-only', analyzedFiles: ['src/paginate.ts'], skippedFiles: [] });
    expect(reportSchema.parse(report)).toEqual(report);
  });

  it('keys exact revisions and configuration independently of object property order', async () => {
    adapter = await FixtureRepositoryAdapter.open();
    const input = await adapter.revisions();
    const identity = runIdentity(input, fixtureConfig);
    expect(runIdentity({ headSha: input.headSha, baseSha: input.baseSha, pullRequestNumber: 1, repositoryId: input.repositoryId, source: 'fixture' }, fixtureConfig)).toEqual(identity);
    expect(runIdentity({ ...input, baseSha: input.headSha }, fixtureConfig).logicalKey).not.toBe(identity.logicalKey);
    expect(runIdentity({ ...input, headSha: input.baseSha }, fixtureConfig).logicalKey).not.toBe(identity.logicalKey);
    expect(digest({ version: 1 })).not.toBe(digest({ version: 2 }));
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
  });

  it('refuses mismatched revisions and missing source rather than fabricating coverage', async () => {
    adapter = await FixtureRepositoryAdapter.open();
    const input = await adapter.revisions();
    const wrong = { ...input, headSha: input.baseSha };
    await expect(analyzeFixture(adapter, wrong, fixtureConfig, { runId: randomUUID(), ...runIdentity(wrong, fixtureConfig) })).rejects.toThrow('metadata mismatch');
    await expect(adapter.fileAt(input.headSha, '../outside')).rejects.toThrow('Invalid repository path');
    await expect(adapter.fileAt('not-a-sha', 'src/paginate.ts')).rejects.toThrow();
  });
});
