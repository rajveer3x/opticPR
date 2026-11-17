import { expect, it, vi } from 'vitest';
import { githubConfig, modelOutputJsonSchema, modelOutputSchema } from '../packages/contracts/src/index.js';
import { excludedPath, excludedSource, headHunks, sourceContexts } from '../apps/worker/src/context.js';
import { validAnchor } from '../apps/worker/src/local-analysis.js';
import { ollamaClient, ollamaUrl } from '../apps/worker/src/inference.js';

const revision = 'b'.repeat(40);
const source = 'export function review(value: string) {\n  const before = value.trim();\n  eval(before);\n  return before;\n}\n';
const patch = '@@ -1,4 +1,5 @@\n export function review(value: string) {\n   const before = value.trim();\n+  eval(before);\n   return before;\n }';
it('maps exact TypeScript functions and JS methods with Tree-sitter, with bounded fallbacks', async () => {
  const contexts = await sourceContexts(revision, 'src/a.ts', source, headHunks(patch), 'function-context');
  expect(contexts).toHaveLength(1);
  expect(contexts[0]).toMatchObject({ kind: 'function', revision, startLine: 1, endLine: 5, source: source.trimEnd(), changedLines: [3] });
  const method = 'class A {\n  run(value) {\n    eval(value);\n  }\n}';
  const methodHunk = headHunks('@@ -1,4 +1,5 @@\n class A {\n   run(value) {\n+    eval(value);\n   }\n }');
  expect((await sourceContexts(revision, 'a.js', method, methodHunk, 'function-context'))[0]).toMatchObject({ kind: 'function', startLine: 2, endLine: 4 });
  const arrow = 'const run = (value: string) => {\n  eval(value);\n};';
  expect((await sourceContexts(revision, 'a.tsx', arrow, headHunks('@@ -1,2 +1,3 @@\n const run = (value: string) => {\n+  eval(value);\n };'), 'function-context'))[0]?.kind).toBe('function');
  const broken = await sourceContexts(revision, 'a.ts', source.replace('return before;', 'return (!!!;'), headHunks(patch), 'function-context');
  expect(broken[0]).toMatchObject({ kind: 'hunk', reason: 'parse failed' });
  const long = `function long() {\n${'  // filler\n'.repeat(80)}  eval(input);\n}`;
  const large = await sourceContexts(revision, 'a.js', long, headHunks('@@ -81,2 +81,3 @@\n   // filler\n+  eval(input);\n }'), 'function-context', 200);
  expect(large[0]).toMatchObject({ kind: 'hunk', reason: 'function exceeds budget' });
  expect(large[0]!.source.length).toBeLessThan(200);
  expect((await sourceContexts(revision, 'a.ts', source, headHunks(patch), 'diff-only'))[0]).toMatchObject({ kind: 'hunk', reason: 'diff-only mode' });
});
it('merges separate hunks in one function and recognizes changed exported signatures', async () => {
  const changes = headHunks('@@ -1 +1 @@\n-export function review(value) {\n+export function review(value: string) {\n@@ -3 +3 @@\n-  return value;\n+  eval(before);');
  const contexts = await sourceContexts(revision, 'a.ts', source, changes, 'function-context');
  expect(contexts).toHaveLength(1);
  expect(contexts[0]).toMatchObject({ kind: 'function', startLine: 1, endLine: 5, changedLines: [1, 3] });
  expect(contexts[0]!.diff).toContain('+export function review(value: string) {');
  expect(contexts[0]!.diff).toContain('+  eval(before);');
});
it('only accepts exact, changed, head-side full-line excerpts', () => {
  const file = { path: 'a.ts', source, change: { path: 'a.ts', hunk: patch } };
  expect(validAnchor(file, { startLine: 3, endLine: 3, excerpt: '  eval(before);' })).toBe(true);
  expect(validAnchor(file, { startLine: 3, endLine: 3, excerpt: 'eval(wrong);' })).toBe(false);
  expect(validAnchor(file, { startLine: 2, endLine: 2, excerpt: '  const before = value.trim();' })).toBe(false);
  expect(validAnchor({ ...file, change: { ...file.change, hunk: patch.replace('+  eval(before);', '+  eval(wrong);') } }, { startLine: 3, endLine: 3, excerpt: '  eval(before);' })).toBe(false);
  expect(headHunks('@@ -3 +2,0 @@\n-eval(input);')[0]?.changed).toEqual([]);
});
it('excludes dependencies, generated files, lockfiles, binaries and secrets before context', () => {
  for (const path of ['node_modules/a.js', 'vendor/a.ts', 'dist/a.js', '.env.ts', 'src/secrets.ts', 'a.min.js', 'foo.generated.ts', 'pnpm-lock.yaml', 'a.png', '../a.ts', '/a.ts', 'src/../a.ts']) expect(excludedPath(path), path).toBeTruthy();
  expect(excludedPath('src/normal.ts')).toBeUndefined();
  for (const value of ['\0', '�', '// @generated\nconst a=1', 'const secret = "1234567890";', '-----BEGIN PRIVATE KEY-----', 'x'.repeat(128 * 1024 + 1)]) expect(excludedSource(value)).toBeTruthy();
  expect(excludedSource(source)).toBeUndefined();
});
it('sends a JSON schema in Ollama format and pins the actual model digest', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: githubConfig.model, digest: githubConfig.modelRevision.slice(7) }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ response: '{"candidates":[]}', done: true })));
  const client = ollamaClient('http://127.0.0.1:11434', fetcher);
  expect(await client({ runId: 'test', prompt: 'source', configuration: githubConfig, signal: new AbortController().signal })).toBe('{"candidates":[]}');
  const body = JSON.parse(fetcher.mock.calls[1]![1].body);
  expect(body.format).toEqual(modelOutputJsonSchema);
  expect(body.options).toMatchObject({ num_ctx: 4096, temperature: 0 });
  expect(body.stream).toBe(false);
  expect(modelOutputSchema.safeParse({ candidates: [{ excerpt: 'incorrect shape' }] }).success).toBe(false);
  const wrong = ollamaClient('http://127.0.0.1:11434', vi.fn().mockResolvedValue(new Response('{"models":[]}')));
  await expect(wrong({ runId: 'test', prompt: '', configuration: githubConfig, signal: new AbortController().signal })).rejects.toThrow('Pinned');
  expect(ollamaUrl('http://localhost:11434')).toBe('http://127.0.0.1:11434');
  expect(() => ollamaUrl('https://example.com')).toThrow('loopback');
});
