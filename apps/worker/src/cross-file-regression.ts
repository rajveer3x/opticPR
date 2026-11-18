import ts from 'typescript';
import type { Finding, Report, ReviewInput } from '@opticpr/contracts';
import type { ChangedFile, RepositoryAdapter } from '@opticpr/repository';
import { AccessRevokedError, digest } from '@opticpr/runtime';
import { excludedPath, excludedSource, headHunks } from './context.js';
import { calleeName, exceptionHandling, fallbackFor, isUnshadowedUndefined, missingBranches, parseTypeScript, relativeImport, syntax } from './cross-file-syntax.js';

export const crossFileRule = 'opticpr.ts-missing-value-throws';
const maxHeadFiles = 40;
const fetchBatch = 6;
const virtualRoot = '/snapshot/';
type File = { path: string; source: string; change: ChangedFile };
type Recheck = NonNullable<Report['crossFileRecheck']>;
type Gap = Report['coverage']['skippedFiles'][number];
type Branch = ReturnType<typeof missingBranches>[number];

const isTypeScript = (path: string) => /\.(?:[cm]?ts|tsx)$/i.test(path) && !excludedPath(path);
const line = (file: ts.SourceFile, position: number) => file.getLineAndCharacterOfPosition(position).line + 1;

function cite(revision: string, path: string, file: ts.SourceFile, start: ts.Node, end = start, hunk = '') {
  const startLine = line(file, start.getStart(file));
  const endLine = line(file, end.getEnd() - 1);
  return { revision, path, startLine, endLine, excerpt: file.text.split('\n').slice(startLine - 1, endLine).join('\n'), hunk };
}

function snapshotProgram(sources: Map<string, string>) {
  const files = new Map([...sources].map(([path, source]) => [virtualRoot + path, parseTypeScript(virtualRoot + path, source)]));
  const options: ts.CompilerOptions = { noLib: true, types: [], moduleResolution: ts.ModuleResolutionKind.Bundler };
  const fileExists = (name: string) => files.has(name);
  const readFile = (name: string) => files.get(name)?.text;
  const resolutions = ts.createModuleResolutionCache(virtualRoot, name => name, options);
  const resolve = (name: string, from: string) => relativeImport(name)
    ? ts.resolveModuleName(name, from, options, { fileExists, readFile }, resolutions).resolvedModule : undefined;
  const program = ts.createProgram([...files.keys()], options, {
    getSourceFile: name => files.get(name), getDefaultLibFileName: () => '',
    writeFile: () => {}, getCurrentDirectory: () => virtualRoot, getDirectories: () => [],
    fileExists, readFile, getCanonicalFileName: name => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    resolveModuleNames: (names, from) => names.map(name => resolve(name, from)),
  });
  return { program, resolve };
}

function unresolvedImports(file: ts.SourceFile, checker: ts.TypeChecker, resolve: ReturnType<typeof snapshotProgram>['resolve']) {
  return file.statements.some(statement => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) return false;
    const module = statement.moduleSpecifier;
    if (!module || !ts.isStringLiteral(module) || !relativeImport(module.text)) return false;
    if (!resolve(module.text, file.fileName)) return true;
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) return false;
    const bindings = statement.importClause?.namedBindings;
    const names = bindings && ts.isNamedImports(bindings) ? bindings.elements.filter(item => !item.isTypeOnly).map(item => item.name) : [];
    if (statement.importClause?.name) names.push(statement.importClause.name);
    return names.some(name => {
      const symbol = checker.getSymbolAtLocation(name);
      return !symbol || !(symbol.flags & ts.SymbolFlags.Alias) || !checker.getAliasedSymbol(symbol).declarations?.length;
    });
  });
}

function branchPrefix({ declaration, branch }: Branch) {
  const statements = declaration.body!.statements;
  return digest({ parameters: declaration.parameters.map(syntax),
    prefix: statements.slice(0, statements.indexOf(branch)).map(syntax), guard: syntax(branch.expression) });
}

function correspondingReturn(base: ts.SourceFile, checker: ts.TypeChecker, head: Branch) {
  const prefix = branchPrefix(head);
  const previous = missingBranches(base).filter(candidate => {
    if (!ts.isReturnStatement(candidate.action) || candidate.declaration.name!.text !== head.declaration.name!.text || branchPrefix(candidate) !== prefix) return false;
    let expression = candidate.action.expression;
    while (expression && ts.isParenthesizedExpression(expression)) expression = expression.expression;
    return !expression || (ts.isIdentifier(expression) && isUnshadowedUndefined(expression, checker));
  });
  return previous.length === 1 ? previous[0]!.action : undefined;
}

export async function scanCrossFileRegression(
  adapter: RepositoryAdapter, input: ReviewInput, snapshots: File[], prior: { callee: string; caller?: string }[],
) {
  const findings: Finding[] = [];
  const gaps: Gap[] = [];
  const recheck: Recheck = { completed: false, callees: [], callers: [], observations: [] };
  const result = { findings, gaps, recheck };
  const headSnapshots = new Map(snapshots.filter(file => isTypeScript(file.path)).map(file => [file.path, file]));
  const priorCallees = new Set(prior.map(pair => pair.callee));
  const focus = new Map([...headSnapshots].filter(([path, file]) =>
    priorCallees.has(path) || missingBranches(parseTypeScript(path, file.source)).some(branch => ts.isThrowStatement(branch.action))));
  if (!focus.size && !prior.length) { recheck.completed = true; return result; }

  const gap = (path: string, reason: string) => {
    if (!gaps.some(item => item.path === path && item.reason === reason)) gaps.push({ path, reason });
  };
  async function tree(revision: string) {
    try {
      const listing = await adapter.sourceTreeAt?.(revision);
      if (listing) return listing;
    } catch (error) { if (error instanceof AccessRevokedError) throw error; }
    return undefined;
  }
  const headTree = await tree(input.headSha);
  if (!headTree) { gap('.', 'TypeScript caller source tree unavailable'); return result; }
  if (!headTree.complete) gap('.', 'TypeScript caller source tree truncated');
  const paths = new Set(headTree.paths.filter(isTypeScript));
  const order = new Set([...focus.keys(), ...prior.flatMap(pair => pair.caller ? [pair.caller] : []), ...[...paths].sort()]);
  const eligible = [...order].filter(path => paths.has(path));
  if (eligible.length > maxHeadFiles) gap('.', `TypeScript caller budget exhausted (first ${maxHeadFiles} of ${eligible.length} eligible head files)`);
  const sources = new Map<string, string>();
  const selected = eligible.slice(0, maxHeadFiles);
  for (let index = 0; index < selected.length; index += fetchBatch) {
    await Promise.all(selected.slice(index, index + fetchBatch).map(async path => {
      try {
        const source = headSnapshots.get(path)?.source ?? await adapter.fileAt(input.headSha, path);
        const excluded = excludedSource(source);
        if (excluded) gap(path, `TypeScript caller scan: ${excluded}`);
        else sources.set(path, source);
      } catch (error) {
        if (error instanceof AccessRevokedError) throw error;
        gap(path, 'TypeScript head source unavailable');
      }
    }));
  }

  const { program, resolve } = snapshotProgram(sources);
  const checker = program.getTypeChecker();
  const parsed = new Map<string, ts.SourceFile>();
  for (const path of selected) {
    const file = program.getSourceFile(virtualRoot + path);
    if (!file) continue;
    if (program.getSyntacticDiagnostics(file).length) { gap(path, 'TypeScript syntax could not be parsed'); continue; }
    parsed.set(path, file);
    if (unresolvedImports(file, checker, resolve)) gap(path, 'TypeScript local import or symbol could not be resolved');
  }
  recheck.callers = [...parsed.keys()];
  for (const { callee, caller } of prior) {
    if (!focus.has(callee) || !parsed.has(callee)) gap(callee, 'Prior TypeScript callee unavailable for recheck');
    if (!caller || !parsed.has(caller)) gap(caller ?? callee, 'Prior TypeScript caller unavailable for recheck');
  }

  const throws = new Map<ts.FunctionDeclaration, { evidence: Finding['evidence']; before: Finding['evidence']; branch: Branch; added: boolean }[]>();
  const baseNeeded = [...focus.values()].some(file => file.change.status !== 'added' && parsed.has(file.path) &&
    missingBranches(parsed.get(file.path)!).some(branch => ts.isThrowStatement(branch.action)));
  const baseTree = baseNeeded ? await tree(input.baseSha) : undefined;
  const basePaths = new Set(baseTree?.paths);
  if (baseNeeded && !baseTree?.complete) gap('.', 'TypeScript base source tree unavailable or truncated');
  for (const [path, { change }] of focus) {
    const head = parsed.get(path);
    if (!head) { gap(path, 'TypeScript callee unavailable'); continue; }
    const branches = missingBranches(head).filter(branch => ts.isThrowStatement(branch.action));
    if (!branches.length || change.status === 'added') { recheck.callees.push(path); continue; }
    const basePath = change.previousPath ?? path;
    if (!isTypeScript(basePath) || !basePaths.has(basePath)) { gap(path, 'TypeScript base source unavailable'); continue; }
    let source: string;
    try { source = await adapter.fileAt(input.baseSha, basePath); }
    catch (error) {
      if (error instanceof AccessRevokedError) throw error;
      gap(path, 'TypeScript base source unavailable'); continue;
    }
    const excluded = excludedSource(source);
    if (excluded) { gap(path, `TypeScript base scan: ${excluded}`); continue; }
    const { program: baseProgram } = snapshotProgram(new Map([[basePath, source]]));
    const base = baseProgram.getSourceFile(virtualRoot + basePath)!;
    if (baseProgram.getSyntacticDiagnostics(base).length) { gap(path, 'TypeScript base syntax could not be parsed'); continue; }
    recheck.callees.push(path);
    const patch = headHunks(change.hunk);
    const baseChecker = baseProgram.getTypeChecker();
    const headLines = head.text.split('\n');
    for (const branch of branches) {
      const old = correspondingReturn(base, baseChecker, branch);
      if (!old) continue;
      const start = line(head, branch.action.getStart(head));
      const hunk = patch.find(item => item.addedText[start] === headLines[start - 1]);
      const evidence = cite(input.headSha, path, head, branch.action, branch.action, hunk && !excludedSource(hunk.patch) ? hunk.patch : '');
      const before = cite(input.baseSha, basePath, base, old);
      if (evidence.endLine - evidence.startLine >= 40 || before.endLine - before.startLine >= 40 ||
          evidence.excerpt.length > 8192 || before.excerpt.length > 8192) { gap(path, 'TypeScript callee evidence exceeds excerpt budget'); continue; }
      const matches = throws.get(branch.declaration) ?? [];
      matches.push({ evidence, before, branch, added: !!hunk });
      throws.set(branch.declaration, matches);
    }
  }

  for (const [path, source] of parsed) {
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const symbol = calleeName(node, checker);
        if (symbol === null) gap(path, 'TypeScript local import or symbol could not be resolved');
        for (const declaration of symbol?.declarations ?? []) {
          if (!ts.isFunctionDeclaration(declaration) || declaration.getSourceFile() === source) continue;
          const matches = throws.get(declaration);
          if (!matches) continue;
          const fallback = fallbackFor(node, checker);
          if (!fallback) continue;
          const handling = exceptionHandling(node);
          if (handling === 'uncertain') { gap(path, 'TypeScript caller exception handler could not be verified'); continue; }
          if (handling === 'handled') continue;
          const caller = cite(input.headSha, path, source, node, fallback.fallback);
          if (caller.endLine - caller.startLine >= 12 || caller.excerpt.length > 8192) { gap(path, 'TypeScript caller evidence exceeds excerpt budget'); continue; }
          for (const { evidence, before, branch, added } of matches) {
            const name = declaration.name!.text;
            const expression = digest({ calleeGuard: syntax(branch.branch.expression), call: syntax(node), fallback: syntax(fallback.guard) });
            const finding: Finding = {
              id: digest({ ruleId: crossFileRule, evidence, caller }), source: input.source, ruleId: crossFileRule, severity: 'high',
              title: `${name} now throws before its caller's missing-value fallback`,
              impact: `The same missing-value branch now throws instead of returning undefined. The call in ${path} exits before reaching the fallback shown in the caller citation.`,
              verification: 'Exercise the caller with a missing record and check that it still returns the fallback response.',
              evidence, identity: { kind: 'static', class: crossFileRule, symbol: name, expression },
              citations: [
                { kind: 'static', role: 'changed-throw', ruleId: crossFileRule, evidence },
                { kind: 'static', role: 'caller-fallback', ruleId: crossFileRule, evidence: caller },
                { kind: 'static', role: 'base-return', ruleId: crossFileRule, evidence: before },
              ],
            };
            recheck.observations.push(finding);
            if (added) findings.push(finding);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    if (throws.size || prior.length) visit(source);
  }

  gaps.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
  recheck.completed = gaps.length === 0;
  return result;
}
