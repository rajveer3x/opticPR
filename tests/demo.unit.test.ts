import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { demoManifestSchema, demoReplaySchema, type Finding } from '../packages/contracts/src/index.js';
import { FixtureRepositoryAdapter } from '../packages/repository/src/index.js';

const fixture = new URL('../fixtures/review-demo/', import.meta.url);
const read = async (name: string): Promise<unknown> => JSON.parse(await readFile(new URL(name, fixture), 'utf8'));

it('checks the stored finding, supporting excerpts and clearance against the bundled commits', async () => {
  const manifest = demoManifestSchema.parse(await read('manifest.json'));
  const { regression, fix } = demoReplaySchema.parse(await read('replay.json'));
  expect(regression.report.input).toEqual(manifest.regression);
  expect(fix.report.input).toEqual(manifest.fix);
  const brokenRepo = await FixtureRepositoryAdapter.openReviewDemo(manifest.regression);
  const fixedRepo = await FixtureRepositoryAdapter.openReviewDemo(manifest.fix);
  try {
    const { baseSha, headSha } = manifest.regression;
    const unchanged = async (path: string) => expect(await brokenRepo.fileAt(headSha, path)).toBe(await brokenRepo.fileAt(baseSha, path));
    await unchanged('src/route.ts');
    await unchanged('src/handled.ts');
    expect(await fixedRepo.fileAt(manifest.fix.headSha, 'src/users.ts')).toBe(await brokenRepo.fileAt(headSha, 'src/users.ts'));
    expect((await brokenRepo.changedFiles(baseSha, headSha)).map(file => file.path)).toEqual(['src/users.ts']);
    expect((await fixedRepo.changedFiles(baseSha, manifest.fix.headSha)).map(file => file.path)).toEqual(['src/route.ts', 'src/users.ts']);

    async function verify(evidence: Finding['evidence'], adapter = brokenRepo) {
      const source = await adapter.fileAt(evidence.revision, evidence.path);
      expect(source.split('\n').slice(evidence.startLine - 1, evidence.endLine).join('\n')).toBe(evidence.excerpt);
    }
    expect(regression.report.findings).toHaveLength(1);
    const finding = regression.report.findings[0]!;
    expect(finding.citations?.map(citation => [citation.role, citation.evidence.revision])).toEqual([
      ['changed-throw', headSha], ['caller-fallback', headSha], ['base-return', baseSha],
    ]);
    for (const { evidence } of finding.citations!) await verify(evidence);
    await verify(regression.caller);
    await verify(fix.caller, fixedRepo);
    expect(regression.caller).toMatchObject({ path: 'src/handled.ts', revision: headSha, excerpt: expect.stringContaining('} catch {\n    return { status: 404 };') });
    expect(fix.caller).toMatchObject({ path: 'src/route.ts', revision: manifest.fix.headSha, hunk: expect.stringContaining('+  } catch {') });
    expect(regression.report.history?.findings[0]).toMatchObject({ state: 'new', observation: finding });
    expect(fix.report.findings).toEqual([]);
    expect(fix.report.crossFileRecheck).toMatchObject({ completed: true, callees: ['src/users.ts'], callers: expect.arrayContaining(['src/route.ts']) });
    expect(fix.report.history?.findings).toMatchObject([{ state: 'cleared_by_recheck', lastObservation: finding,
      previous: { runId: regression.report.runId, findingId: finding.id } }]);
    expect(fix.report.configurationDigest).toBe(regression.report.configurationDigest);
  } finally {
    await Promise.all([brokenRepo.close(), fixedRepo.close()]);
  }
});

it('rejects a different repository or unlisted revision', async () => {
  const { regression } = demoManifestSchema.parse(await read('manifest.json'));
  await expect(FixtureRepositoryAdapter.openReviewDemo({ ...regression, repositoryId: 'private/repo' })).rejects.toThrow('Unknown review demo comparison');
  await expect(FixtureRepositoryAdapter.openReviewDemo({ ...regression, headSha: 'a'.repeat(40) })).rejects.toThrow('Unknown review demo comparison');
});
