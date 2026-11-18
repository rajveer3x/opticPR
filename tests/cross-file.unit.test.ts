import { expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { scanCrossFileRegression } from '../apps/worker/src/cross-file-regression.js';
import { inlineAnchor } from '../apps/worker/src/inline-comments.js';
import { missingUserFixture, routePath, usersPath } from './cross-file-fixture.js';

const input = { source: 'github' as const, repositoryId: '200', pullRequestNumber: 9, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) };
async function scan(options?: Parameters<typeof missingUserFixture>[1]) {
  const { adapter, reads } = missingUserFixture(input, options);
  const changes = await adapter.changedFiles(input.baseSha, input.headSha);
  const snapshots = await Promise.all(changes.map(async change => ({ path: change.path, source: await adapter.fileAt(input.headSha, change.path), change })));
  return { ...await scanCrossFileRegression(adapter, input, snapshots, []), reads, changes };
}

it('follows a renamed import to the changed throw and cites the unchanged 404 fallback and base return', async () => {
  const { findings, changes, recheck, gaps, reads } = await scan();
  expect(gaps).toEqual([]);
  expect(recheck.completed).toBe(true);
  expect(findings).toHaveLength(1);
  const finding = findings[0]!;
  expect(finding.evidence).toMatchObject({ revision: input.headSha, path: usersPath, startLine: 4, endLine: 4,
    excerpt: "    throw new Error('User not found');" });
  expect(finding.citations).toMatchObject([
    { role: 'changed-throw', evidence: finding.evidence },
    { role: 'caller-fallback', evidence: { revision: input.headSha, path: routePath, startLine: 3, endLine: 4,
      excerpt: '  const user = getUser(id);\n  if (!user) return { status: 404 };', hunk: '' } },
    { role: 'base-return', evidence: { revision: input.baseSha, path: usersPath, startLine: 4, endLine: 4, excerpt: '    return undefined;', hunk: '' } },
  ]);
  expect(reads).toContainEqual({ sha: input.headSha, path: routePath });
  expect(inlineAnchor(finding, input.headSha, changes)).toEqual({ path: usersPath, line: 4, side: 'RIGHT' });
  for (const citation of finding.citations!.slice(1)) {
    expect(inlineAnchor({ ...finding, evidence: citation.evidence }, input.headSha, changes)).toBeUndefined();
  }
});

it('runs the trusted missing-user example and observes 404, a thrown error, and the handled 404', async () => {
  const { adapter } = missingUserFixture(input);
  const load = (source: string, imports: Record<string, unknown> = {}) => {
    const exports: Record<string, (id: string) => { status: number }> = {};
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } });
    runInNewContext(outputText, { exports, require: (path: string) => imports[path] });
    return exports;
  };
  const base = load(await adapter.fileAt(input.baseSha, usersPath));
  const head = load(await adapter.fileAt(input.headSha, usersPath));
  const route = await adapter.fileAt(input.headSha, routePath);
  const handled = await adapter.fileAt(input.headSha, 'src/handled.ts');
  expect(load(route, { './users.js': base }).route!('missing').status).toBe(404);
  expect(() => load(route, { './users.js': head }).route!('missing')).toThrow('User not found');
  expect(load(handled, { './users.js': head }).route!('missing').status).toBe(404);
});

it('detects a named import used directly in a nullish guard, with a namespace call as a second caller', async () => {
  const { findings, gaps } = await scan({
    route: `import { findUser } from './users';\nexport function route(id: string) {\n  if (findUser(id) == null) return { status: 404 };\n}`,
    extra: { 'src/namespace.ts': `import * as users from './users';\nexport function route(id: string) {\n  if (!users.findUser(id)) return { status: 404 };\n}` },
  });
  expect(gaps).toEqual([]);
  expect(findings.map(finding => finding.citations![1]!.evidence.path)).toEqual(['src/namespace.ts', routePath]);
});

it('marks missing local imports and incomplete file budgets as partial without dropping verified findings', async () => {
  const extra = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`src/z${i}.ts`, 'export {};']));
  const { findings, gaps, recheck, reads } = await scan({ extra: { 'src/missing.ts': `import { findUser } from './unavailable';\nfindUser('x');`, ...extra } });
  expect(findings).toHaveLength(1);
  expect(recheck.completed).toBe(false);
  expect(gaps).toEqual(expect.arrayContaining([
    { path: '.', reason: expect.stringContaining('caller budget exhausted') },
    { path: 'src/missing.ts', reason: expect.stringContaining('could not be resolved') },
  ]));
  expect(reads.filter(read => read.sha === input.headSha)).toHaveLength(40);
});

it('requires the compiler to resolve the imported symbol and the guard binding', async () => {
  const { findings, gaps } = await scan({
    route: `import { missingExport as getUser } from './users';\nexport function route(id: string) {\n  const user = getUser(id);\n  if (!user) return { status: 404 };\n}`,
    extra: {
      'src/shadowed.ts': `import { findUser } from './users';\nexport function route(findUser: (id: string) => unknown) {\n  const user = findUser('x');\n  if (!user) return { status: 404 };\n}`,
      'src/unknown-member.ts': `import * as users from './users';\nexport function route(id: string) {\n  if (!users.unknown(id)) return { status: 404 };\n}`,
    },
  });
  expect(findings).toEqual([]);
  expect(gaps).toEqual([routePath, 'src/unknown-member.ts'].map(path => ({ path, reason: 'TypeScript local import or symbol could not be resolved' })));
});
