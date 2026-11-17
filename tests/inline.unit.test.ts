import { expect, it } from 'vitest';
import type { Finding } from '../packages/contracts/src/index.js';
import { addedHeadLines, inlineAnchor } from '../apps/worker/src/inline-comments.js';

const patch = '@@ -1,4 +1,3 @@\n start\n-obsolete\n-old\n+first\n end\n@@ -10,2 +9,3 @@\n later\n+second\n finish';
const head = 'b'.repeat(40);
function finding(line = 10, excerpt = 'second'): Finding {
  return { id: 'finding', source: 'github', ruleId: 'rule', title: 'Defect', impact: 'Impact', verification: 'Check', severity: 'high',
    evidence: { revision: head, path: 'src/new.ts', startLine: line, endLine: line, excerpt, hunk: patch } };
}
it('maps head source lines across hunks after deletions, including omitted counts and no final newline', () => {
  expect([...addedHeadLines(patch)]).toEqual([[2, 'first'], [10, 'second']]);
  expect([...addedHeadLines('@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n')]).toEqual([[1, 'new']]);
  expect([...addedHeadLines('@@ -0,0 +1,2 @@\n+++ code\n+last')]).toEqual([[1, '++ code'], [2, 'last']]);
  expect([...addedHeadLines('@@ -1,2 +0,0 @@\n-one\n-two')]).toEqual([]);
});
it('rejects truncated, overlapping and malformed patches instead of guessing a coordinate', () => {
  for (const invalid of [patch.slice(0, -7), '@@\n+new', '@@ -1 +1 @@\n+new', '@@ -1 +1 @@\n-old\n+new\n+extra', `${patch}\n@@ -2 +2 @@\n-a\n+b`]) {
    expect([...addedHeadLines(invalid)]).toEqual([]);
  }
});
it('anchors only matching added head evidence using the renamed destination path', () => {
  const changes = [{ path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', hunk: patch }];
  expect(inlineAnchor(finding(), head, changes)).toEqual({ path: 'src/new.ts', line: 10, side: 'RIGHT' });
  for (const item of [finding(9, 'later'), finding(10, 'wrong'), { ...finding(), evidence: { ...finding().evidence, path: 'src/old.ts' } },
    { ...finding(), evidence: { ...finding().evidence, revision: 'c'.repeat(40) } }]) expect(inlineAnchor(item, head, changes)).toBeUndefined();
  expect(inlineAnchor(finding(), head, [])).toBeUndefined();
  expect(inlineAnchor(finding(), head, [{ ...changes[0]!, status: 'removed' }])).toBeUndefined();
});
