import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Parser, Language, type Node } from 'web-tree-sitter';
import type { ChangedFile } from '@opticpr/repository';

export interface HeadHunk { startLine: number; endLine: number; changed: number[]; addedText: Record<number, string>; removed: number; patch: string }
/** Only '+' head lines can anchor a finding; context and deletion lines cannot. */
export function headHunks(patch: string): HeadHunk[] {
  const result: HeadHunk[] = [];
  let current: HeadHunk | undefined;
  let line = 0;
  for (const text of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (header) {
      line = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      current = { startLine: line, endLine: line + count - 1, changed: [], addedText: {}, removed: 0, patch: text };
      result.push(current);
    } else if (current) {
      if (text.startsWith('diff ') || text.startsWith('--- ') || text.startsWith('+++ ')) { current = undefined; continue; }
      current.patch += `\n${text}`;
      if (text.startsWith('+')) { current.changed.push(line); current.addedText[line] = text.slice(1); line++; }
      else if (text.startsWith(' ')) line++;
      else if (text.startsWith('-')) current.removed++;
    }
  }
  return result;
}
export const changedLines = (file: ChangedFile) => headHunks(file.hunk).reduce((sum, hunk) => sum + hunk.changed.length + hunk.removed, 0);
export function excludedPath(path: string): string | undefined {
  if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => part === '..' || part === '.' || !part)) return 'unsafe path';
  if (/(^|\/)(node_modules|vendor|dist|build|coverage|generated|__generated__|\.git|\.next)(\/|$)/i.test(path)) return 'dependencies or generated code';
  if (/(^|\/)(\.env(?:\..*)?|.*(?:secret|credential|private[-_]?key).*|.*\.(?:pem|key|p12|pfx))$/i.test(path)) return 'secret file';
  if (/lock(?:\.json|\.yaml)?$|\.lock$|\.min\.[cm]?js$|\.generated\.[jt]sx?$|\.d\.[cm]?ts$/i.test(path)) return 'lockfile or generated code';
  if (!/\.(?:[cm]?[jt]s|jsx|tsx)$/i.test(path)) return 'unsupported file type';
}
export function excludedSource(source: string): string | undefined {
  if (source.includes('\0') || source.includes('\ufffd')) return 'binary or invalid UTF-8';
  if (Buffer.byteLength(source) > 128 * 1024) return 'source size budget';
  if (/@generated|auto[- ]generated|DO NOT EDIT/i.test(source.slice(0, 2000))) return 'generated code';
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:AKIA|ASIA)[A-Z0-9]{16}|\bgh[pousr]_[A-Za-z0-9]{20,}|\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"'\n]{8,}["']/i.test(source)) return 'possible embedded secret';
}

export interface SourceContext { revision: string; path: string; startLine: number; endLine: number; source: string; kind: 'function' | 'hunk'; changedLines: number[]; diff: string; reason?: string }
let initialization: Promise<void> | undefined;
const languages = new Map<string, Language>();
const require = createRequire(import.meta.url);
async function languageFor(path: string) {
  await (initialization ??= Parser.init());
  const name = /\.tsx$/i.test(path) ? 'tsx' : /\.[cm]?ts$/i.test(path) ? 'typescript' : 'javascript';
  if (!languages.has(name)) {
    const pkg = name === 'javascript' ? 'tree-sitter-javascript' : 'tree-sitter-typescript';
    languages.set(name, await Language.load(join(dirname(require.resolve(`${pkg}/package.json`)), `tree-sitter-${name}.wasm`)));
  }
  return languages.get(name)!;
}
const functionTypes = new Set(['function_declaration', 'function_expression', 'generator_function_declaration', 'generator_function', 'arrow_function', 'method_definition']);
export async function sourceContexts(revision: string, path: string, source: string, hunks: HeadHunk[], mode: 'diff-only' | 'function-context', maxChars = 6000): Promise<SourceContext[]> {
  const lines = source.split('\n');
  const contexts: SourceContext[] = [];
  let parser: Parser | undefined;
  let tree: ReturnType<Parser['parse']> = null;
  let parseFailed = false;
  if (mode === 'function-context') {
    try {
      const language = await languageFor(path);
      parser = new Parser(); parser.setLanguage(language);
      tree = parser.parse(source);
      parseFailed = !tree || tree.rootNode.hasError;
    } catch { parseFailed = true; }
  }
  try {
    const functions = tree && !parseFailed ? tree.rootNode.descendantsOfType([...functionTypes]).filter((node): node is Node => node !== null) : [];
    const append = (context: SourceContext) => {
      const previous = contexts.find(item => item.startLine === context.startLine && item.endLine === context.endLine);
      if (!previous) { contexts.push(context); return; }
      previous.changedLines = [...new Set([...previous.changedLines, ...context.changedLines])].sort((a, b) => a - b);
      if (!previous.diff.includes(context.diff)) previous.diff += `\n${context.diff}`;
    };
    for (const hunk of hunks) {
      if (!hunk.changed.length) continue;
      // Hunks carry lines, not columns: include exported signatures and arrow
      // declarations whose function node begins after a keyword on the same line.
      const enclosing: Node | null = functions.filter(node => node.startPosition.row + 1 <= hunk.changed[0]! && node.endPosition.row + 1 >= hunk.changed.at(-1)!)
        .sort((a, b) => (a.endIndex - a.startIndex) - (b.endIndex - b.startIndex))[0] ?? null;
      const startLine = enclosing ? enclosing.startPosition.row + 1 : Math.max(1, hunk.changed[0]! - 3);
      const endLine = enclosing ? enclosing.endPosition.row + 1 : Math.min(lines.length, hunk.changed.at(-1)! + 3);
      let context: SourceContext = { revision, path, startLine, endLine, source: lines.slice(startLine - 1, endLine).join('\n'), kind: enclosing ? 'function' : 'hunk', changedLines: hunk.changed, diff: boundedDiff(hunk, startLine, endLine) };
      if (context.source.length > maxChars || !enclosing) {
        // Each changed line gets a bounded window when an entire function/hunk cannot fit.
        for (const line of hunk.changed) {
          const start = Math.max(1, line - 3), end = Math.min(lines.length, line + 3);
          const excerpt = lines.slice(start - 1, end).join('\n');
          if (excerpt.length > maxChars) continue;
          context = { revision, path, startLine: start, endLine: end, source: excerpt, kind: 'hunk', changedLines: hunk.changed.filter(line => line >= start && line <= end), diff: boundedDiff(hunk, start, end),
            reason: mode === 'diff-only' ? 'diff-only mode' : parseFailed ? 'parse failed' : enclosing ? 'function exceeds budget' : 'no enclosing function' };
          append(context);
        }
      } else append(context);
    }
    return contexts;
  } finally { tree?.delete(); parser?.delete(); }
}

function boundedDiff(hunk: HeadHunk, start: number, end: number) {
  let line = hunk.startLine;
  const result: string[] = [];
  for (const text of hunk.patch.split('\n').slice(1)) {
    if (line >= start && line <= end && /^[+ -]/.test(text)) result.push(text);
    if (text.startsWith('+') || text.startsWith(' ')) line++;
  }
  return result.join('\n');
}
