import ts from 'typescript';

/**
 * Static analysis behind tests/unit/activity-coverage.test.ts.
 *
 * Finds every exported function of every `'use server'` module and decides, from source text alone,
 * whether it records activity: it calls `logActivity` itself, or calls a function that does. Calls
 * are followed through same-file helpers and named imports (path alias `@/` or relative) up to
 * MAX_DEPTH hops (action -> feature service -> helper). A logging marker is either a call to
 * `logActivity` or SQL text that inserts into `activity_log` / calls a SQL function known to
 * (`create_session`, verified against its migration by the test).
 *
 * This is a reachability check, not a proof that the log call runs on every path: it cannot tell a
 * success-path entry from one in an error branch. It exists to catch the common regression: a new
 * or edited mutating action that never reaches the activity log at all.
 */

export const MAX_DEPTH = 3;

export type SourceFiles = Record<string, string>;

export type ActionInfo = { file: string; name: string; logs: boolean };

type FnInfo = { name: string; body: ts.Node; exported: boolean };
type ModuleInfo = {
  file: string;
  useServer: boolean;
  fns: Map<string, FnInfo>;
  imports: Map<string, { spec: string; imported: string }>;
  /** Exports the analysis cannot see into (re-exports, `export default`, `export { x }`). */
  unanalysable: string[];
};

const LOG_CALL = 'logActivity';
const SQL_MARKER = /activity_log|public\.create_session\(/;

function parse(file: string, source: string): ModuleInfo {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const info: ModuleInfo = { file, useServer: false, fns: new Map(), imports: new Map(), unanalysable: [] };

  const first = sf.statements[0];
  info.useServer = !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use server';

  const isExported = (n: ts.Node) => !!(ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      for (const el of st.importClause.namedBindings.elements) {
        info.imports.set(el.name.text, { spec: st.moduleSpecifier.text, imported: (el.propertyName ?? el.name).text });
      }
    } else if (ts.isFunctionDeclaration(st) && st.name && st.body) {
      info.fns.set(st.name.text, { name: st.name.text, body: st.body, exported: isExported(st) });
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          info.fns.set(d.name.text, { name: d.name.text, body: d.initializer.body, exported: isExported(st) });
        }
      }
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      info.unanalysable.push(st.getText(sf));
    } else if (ts.isExportAssignment(st)) {
      info.unanalysable.push(st.getText(sf));
    }
  }
  return info;
}

/** Resolves an import specifier to a key of `files`, or null (packages, unknown files). */
export function resolveSpecifier(from: string, spec: string, files: SourceFiles): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith('.')) {
    const parts = from.split('/').slice(0, -1);
    for (const seg of spec.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg !== '.') parts.push(seg);
    }
    base = parts.join('/');
  } else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base]) {
    if (candidate in files) return candidate;
  }
  return null;
}

/** Which exported functions of each `'use server'` module reach activity logging. */
export function analyzeServerActions(files: SourceFiles): { actions: ActionInfo[]; unanalysable: { file: string; text: string }[] } {
  const modules = new Map<string, ModuleInfo>();
  const moduleOf = (file: string): ModuleInfo | null => {
    if (!(file in files)) return null;
    let m = modules.get(file);
    if (!m) {
      m = parse(file, files[file]!);
      modules.set(file, m);
    }
    return m;
  };

  const memo = new Map<string, boolean>();
  function fnLogs(file: string, name: string, depth: number, stack: Set<string>): boolean {
    const key = `${file}#${name}`;
    if (stack.has(key)) return false;
    const mod = moduleOf(file);
    const fn = mod?.fns.get(name);
    if (!mod || !fn) return false;
    if (memo.get(key)) return true; // only positives are cached: a negative can depend on the depth budget
    stack.add(key);
    let found = false;
    const visit = (n: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const callee = n.expression.text;
        if (callee === LOG_CALL) {
          found = true;
          return;
        }
        if (mod.fns.has(callee)) {
          if (fnLogs(file, callee, depth, stack)) found = true;
        } else {
          const imp = mod.imports.get(callee);
          if (imp && depth < MAX_DEPTH) {
            const target = resolveSpecifier(file, imp.spec, files);
            if (target && fnLogs(target, imp.imported, depth + 1, stack)) found = true;
          }
        }
      } else if ((ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isStringLiteral(n)) && SQL_MARKER.test(templateText(n))) {
        found = true;
        return;
      }
      if (!found) ts.forEachChild(n, visit);
    };
    visit(fn.body);
    stack.delete(key);
    if (found) memo.set(key, true);
    return found;
  }

  const actions: ActionInfo[] = [];
  const unanalysable: { file: string; text: string }[] = [];
  for (const file of Object.keys(files).sort()) {
    const mod = moduleOf(file);
    if (!mod?.useServer) continue;
    for (const text of mod.unanalysable) unanalysable.push({ file, text });
    for (const fn of mod.fns.values()) {
      if (!fn.exported) continue;
      actions.push({ file, name: fn.name, logs: fnLogs(file, fn.name, 0, new Set()) });
    }
  }
  return { actions, unanalysable };
}

function templateText(n: ts.Node): string {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => s.literal.text).join(' ');
  return '';
}
