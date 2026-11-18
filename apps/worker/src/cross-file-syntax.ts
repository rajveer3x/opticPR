import ts from 'typescript';

export function parseTypeScript(path: string, source: string) {
  return ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true);
}

export const relativeImport = (name: string) => name.startsWith('./') || name.startsWith('../');

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

/** A recognizable missing-value test. No assumptions about arbitrary predicates. */
function missingOperand(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrap(expression);
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) return unwrap(expression.operand);
  if (!ts.isBinaryExpression(expression) || ![ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(expression.operatorToken.kind)) return;
  if (isMissing(expression.right)) return unwrap(expression.left);
  if (isMissing(expression.left)) return unwrap(expression.right);
}

function isMissing(expression: ts.Expression) {
  expression = unwrap(expression);
  return expression.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expression) && expression.text === 'undefined');
}

function onlyStatement(statement: ts.Statement) {
  return ts.isBlock(statement) ? statement.statements.length === 1 ? statement.statements[0] : undefined : statement;
}

export function missingBranches(file: ts.SourceFile) {
  return file.statements.flatMap(declaration => {
    if (!ts.isFunctionDeclaration(declaration) || !declaration.name || !declaration.body || declaration.asteriskToken ||
        !declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
        declaration.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return [];
    return declaration.body.statements.flatMap(branch => {
      if (!ts.isIfStatement(branch) || !missingOperand(branch.expression)) return [];
      const action = onlyStatement(branch.thenStatement);
      return action && (ts.isThrowStatement(action) || (ts.isReturnStatement(action) &&
        (!action.expression || (isMissing(action.expression) && unwrap(action.expression).kind !== ts.SyntaxKind.NullKeyword))))
        ? [{ declaration, branch, action }] : [];
    });
  });
}

/** Compare syntax and token text while ignoring formatting and comments. */
export function syntax(node: ts.Node): string {
  const children = node.getChildren().filter(child => child.kind !== ts.SyntaxKind.JSDoc);
  return children.length ? children.map(syntax).filter(Boolean).join(' ') :
    node.getWidth() ? JSON.stringify([node.kind, node.getText()]) : '';
}

export function isUnshadowedUndefined(node: ts.Identifier, checker: ts.TypeChecker) {
  return node.text === 'undefined' && !checker.getSymbolAtLocation(node)?.declarations?.length;
}

export function fallbackFor(call: ts.CallExpression, checker: ts.TypeChecker) {
  let value: ts.Expression = call;
  while (ts.isParenthesizedExpression(value.parent)) value = value.parent;
  let guard = value.parent;
  let binding: ts.Symbol | undefined;
  if (ts.isVariableDeclaration(guard) && guard.initializer === value && ts.isIdentifier(guard.name)) {
    const list = guard.parent;
    const statement = list.parent;
    if (!ts.isVariableDeclarationList(list) || !(list.flags & ts.NodeFlags.Const) || list.declarations.length !== 1 ||
        !ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) return;
    binding = checker.getSymbolAtLocation(guard.name);
    if (!binding) return;
    const statements = statement.parent.statements;
    const next = statements[statements.indexOf(statement) + 1];
    if (!next) return;
    guard = next;
  } else if (ts.isPrefixUnaryExpression(guard) || ts.isBinaryExpression(guard)) {
    while (ts.isParenthesizedExpression(guard.parent)) guard = guard.parent;
    guard = guard.parent;
  }
  if (!ts.isIfStatement(guard)) return;
  const operand = missingOperand(guard.expression);
  if (!operand || (binding ? !ts.isIdentifier(operand) || checker.getSymbolAtLocation(operand) !== binding : operand !== call)) return;
  const condition = unwrap(guard.expression);
  if (ts.isBinaryExpression(condition)) {
    for (const side of [unwrap(condition.left), unwrap(condition.right)]) {
      if (ts.isIdentifier(side) && side.text === 'undefined' && !isUnshadowedUndefined(side, checker)) return;
      // A strict null comparison would not catch the old undefined value.
      if (side.kind === ts.SyntaxKind.NullKeyword && condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return;
    }
  }
  const fallback = onlyStatement(guard.thenStatement);
  if (fallback && ts.isReturnStatement(fallback)) return { guard, fallback };
}

export function exceptionHandling(call: ts.CallExpression) {
  for (let parent: ts.Node = call; parent.parent && !ts.isFunctionLike(parent); parent = parent.parent) {
    const statement = parent.parent;
    if (!ts.isTryStatement(statement) || statement.tryBlock !== parent || !statement.catchClause) continue;
    const handler = onlyStatement(statement.catchClause.block);
    if (handler && ts.isReturnStatement(handler)) return 'handled';
    if (!handler || !ts.isThrowStatement(handler)) return 'uncertain';
  }
  return 'escapes';
}

export function calleeName(call: ts.CallExpression, checker: ts.TypeChecker) {
  if (ts.isIdentifier(call.expression)) {
    const alias = checker.getSymbolAtLocation(call.expression);
    return alias && (alias.flags & ts.SymbolFlags.Alias) && alias.declarations?.some(node =>
      ts.isImportSpecifier(node) ? !node.isTypeOnly && !node.parent.parent.isTypeOnly : ts.isImportClause(node) && !node.isTypeOnly)
      ? checker.getAliasedSymbol(alias) : undefined;
  }
  if (ts.isPropertyAccessExpression(call.expression) && ts.isIdentifier(call.expression.expression)) {
    const namespace = checker.getSymbolAtLocation(call.expression.expression);
    const declaration = namespace?.declarations?.find(ts.isNamespaceImport);
    if (!declaration || declaration.parent.isTypeOnly || !ts.isImportDeclaration(declaration.parent.parent)) return;
    const module = declaration.parent.parent.moduleSpecifier;
    if (ts.isStringLiteral(module) && relativeImport(module.text)) return checker.getSymbolAtLocation(call.expression.name) ?? null;
  }
}
