// Shared AST reader over `packages/db/src/repo/**`.
//
// Two suites need the same answer — "what does this module actually export, and
// what is each function's first parameter?" — and they must not disagree: the
// scope-parameter contract (`ast-check`) decides which functions are
// profile/account-scoped, and the binding-shape check (`scoped`) asserts the
// bound runtime surfaces carry exactly those. Two collectors would let one
// suite's notion of "exported" drift from the other's and open the gap between
// them, which is the whole thing being guarded.

import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';

const HERE = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = resolve(HERE, '..', '..');
const DB_TSCONFIG = resolve(DB_ROOT, 'tsconfig.json');

/** Absolute path of `packages/db/src/repo`. */
export const REPO_DIR = resolve(HERE, '..', '..', 'src', 'repo');

export interface ExportedFn {
  name: string;
  paramNames: string[];
  paramTypes: string[];
}

const hasExportModifier = (node: ts.FunctionDeclaration | ts.VariableStatement): boolean =>
  (node.modifierFlags & ts.ModifierFlags.Export) !== 0;

export interface RepoAstReader {
  collectExportedFns(absPath: string): ExportedFn[];
  scopeFirstExportNames(relKey: string, scopeType: 'ProfileScope' | 'AccountScope'): string[];
  close(): void;
}

/**
 * Collects every exported function in a repo module — both
 * `export [async] function name(...)` declarations and
 * `export const name = [async] (...) => ...` arrow / function-expression
 * consts. Covering both shapes keeps the scope contract un-bypassable: a
 * future query written as an exported arrow cannot slip past the check.
 */
export const createRepoAstReader = (): RepoAstReader => {
  const api = new API({ cwd: DB_ROOT });
  const snapshot = api.updateSnapshot({
    openProjects: [DB_TSCONFIG],
  });
  const project = snapshot.getProject(DB_TSCONFIG);

  if (!project) {
    api.close();
    throw new Error(`TypeScript 7 did not load ${DB_TSCONFIG}`);
  }

  const collectExportedFns = (absPath: string): ExportedFn[] => {
    const diagnostics = project.program.getSyntacticDiagnostics(absPath);
    if (diagnostics.length > 0) {
      const first = diagnostics[0];
      throw new Error(
        `${absPath}: failed to parse (${diagnostics.length} error(s)): ${first?.text ?? 'unknown syntax error'}`,
      );
    }

    const src = project.program.getSourceFile(absPath);
    if (!src) {
      throw new Error(`TypeScript 7 project omitted ${absPath}`);
    }

    const out: ExportedFn[] = [];
    const push = (name: string, params: ts.NodeArray<ts.ParameterDeclaration>): void => {
      out.push({
        name,
        paramNames: params.map((parameter) =>
          ts.isIdentifier(parameter.name) ? parameter.name.text : '<destructured>',
        ),
        paramTypes: params.map((parameter) =>
          parameter.type ? parameter.type.getText(src) : '<no-type>',
        ),
      });
    };

    src.forEachChild((node) => {
      if (ts.isFunctionDeclaration(node)) {
        if (hasExportModifier(node) && node.name) {
          push(node.name.text, node.parameters);
        }
        return;
      }

      if (!ts.isVariableStatement(node) || !hasExportModifier(node)) {
        return;
      }

      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          initializer &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          push(declaration.name.text, initializer.parameters);
        }
      }
    });
    return out;
  };

  const scopeFirstExportNames = (
    relKey: string,
    scopeType: 'ProfileScope' | 'AccountScope',
  ): string[] =>
    collectExportedFns(join(REPO_DIR, relKey))
      .filter((fn) => fn.paramNames[0] === 'scope' && fn.paramTypes[0] === scopeType)
      .map((fn) => fn.name)
      .sort();

  return {
    collectExportedFns,
    scopeFirstExportNames,
    close: () => api.close(),
  };
};

/**
 * Every `.ts` file under REPO_DIR, recursively, keyed by its POSIX-relative
 * path. Recursion is mandatory: `repo/projections/*.ts` carries scoped
 * functions too, and a non-recursive scan would leave them un-guarded.
 */
export const collectRepoFiles = (
  dir: string = REPO_DIR,
  prefix = '',
): { relKey: string; absPath: string }[] => {
  const out: { relKey: string; absPath: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relKey = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectRepoFiles(join(dir, entry.name), relKey));
    } else if (entry.name.endsWith('.ts')) {
      out.push({ relKey, absPath: join(dir, entry.name) });
    }
  }
  return out;
};
