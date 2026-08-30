import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript/unstable/ast';
import { createVirtualFileSystem, type FileSystem } from 'typescript/unstable/fs';
import { API, type Checker } from 'typescript/unstable/sync';
import { describe, expect, it } from 'vitest';

const helpersSource = readFileSync(new URL('./_helpers.ts', import.meta.url), 'utf8');
const globalSetupSource = readFileSync(new URL('./global-setup.ts', import.meta.url), 'utf8');
/** The whole walk, before any narrowing. Anchored below: the lexeme prefilter is an optimisation, so the thing that can silently empty the scan is the walk itself, not the filter. */
const apiTestTree = readdirSync(new URL('.', import.meta.url), {
  recursive: true,
  encoding: 'utf8',
}).filter((file) => (file.endsWith('.ts') || file.endsWith('.tsx')) && file !== '_helpers.ts');

const apiTestFiles = apiTestTree
  // Every matching AST necessarily contains these lexemes, so this removes irrelevant files without weakening the ownership check.
  .filter((file) => {
    const source = readFileSync(new URL(file, new URL('.', import.meta.url)), 'utf8');
    return (
      source.includes('redis') &&
      source.includes('raw') &&
      (source.includes('quit') || source.includes('disconnect'))
    );
  })
  .map((file) => ({
    file,
    path: fileURLToPath(new URL(file, new URL('.', import.meta.url))),
  }));

/**
 * Removes syntax-only wrappers so borrower identity is checked at the runtime expression.
 * @param expression - Redis receiver or initializer that may carry type-only wrappers.
 * @returns The underlying runtime expression.
 */
const unwrap = (expression: ts.Expression): ts.Expression => {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertion(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

/**
 * Identifies clients borrowed directly from a fixture DI raw accessor without confusing independently owned Redis instances.
 * @param expression - Candidate client initializer or call receiver.
 * @returns Whether the expression calls a `.redis.raw()` accessor.
 */
const isFixtureRawCall = (expression: ts.Expression): boolean => {
  const node = unwrap(expression);
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'raw' &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    node.expression.expression.name.text === 'redis'
  );
};

/**
 * Walks an AST once per classifier so declaration symbols and termination calls stay separate and scope-safe.
 * @param node - Current TypeScript node.
 * @param visit - Classifier invoked for every descendant including the root.
 * @returns Nothing; findings are written to the caller's accumulator.
 */
const walk = (node: ts.Node, visit: (candidate: ts.Node) => void): void => {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
};

/**
 * Reports only termination calls whose receiver symbol was minted by a fixture raw accessor, preserving explicit owners with the same local name.
 * @param source - Parsed API test or support source.
 * @param checker - Project checker used to resolve lexical binding identity.
 * @param file - Stable diagnostic label for the source.
 * @returns Every borrower-owned lifecycle violation in source order.
 */
const borrowerTerminationViolations = (
  source: ts.SourceFile,
  checker: Checker,
  file: string,
): string[] => {
  const borrowedSymbols = new Set<number>();
  walk(source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFixtureRawCall(node.initializer)
    ) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) borrowedSymbols.add(symbol.id);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isFixtureRawCall(node.right)
    ) {
      const symbol = checker.getSymbolAtLocation(node.left);
      if (symbol) borrowedSymbols.add(symbol.id);
    }
  });

  const violations: string[] = [];
  walk(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const method = node.expression.name.text;
    if (method !== 'quit' && method !== 'disconnect') return;
    const receiver = unwrap(node.expression.expression);
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (isFixtureRawCall(receiver)) {
      violations.push(`${file}:${line}: a fixture-owned raw Redis client is terminated inline`);
      return;
    }
    if (!ts.isIdentifier(receiver)) return;
    const symbol = checker.getSymbolAtLocation(receiver);
    if (symbol && borrowedSymbols.has(symbol.id)) {
      violations.push(
        `${file}:${line}: ${receiver.text} terminates a fixture-owned raw Redis client`,
      );
    }
  });
  return violations;
};

/**
 * Parses one in-memory fixture with the repository TypeScript API so detector self-tests cannot be satisfied by source-text regexes.
 * @param text - Synthetic TypeScript exercising borrower shapes.
 * @returns Borrower termination diagnostics for the synthetic source.
 */
const virtualBorrowerViolations = (text: string): string[] => {
  const config = '/redis-borrower/tsconfig.json';
  const input = '/redis-borrower/input.ts';
  const fs: FileSystem = createVirtualFileSystem({
    [config]: JSON.stringify({ compilerOptions: { noLib: true }, files: ['./input.ts'] }),
    [input]: text,
  });
  const writeFile = fs.writeFile;
  if (!writeFile) throw new Error('TypeScript virtual filesystem is not writable');
  const api = new API({ cwd: '/', fs });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    const source = project?.program.getSourceFile(input);
    if (!project || !source) throw new Error('TypeScript did not load the Redis borrower fixture');
    const diagnostics = project.program.getSyntacticDiagnostics(input);
    if (diagnostics.length > 0) {
      throw new Error(`Redis borrower fixture has ${diagnostics.length} syntax error(s)`);
    }
    return borrowerTerminationViolations(source, project.checker, 'borrower-fixture.ts');
  } finally {
    api.close();
  }
};

/**
 * Checks every API test and support source except the fixture helper that owns and terminates the shared client.
 * @returns Borrower termination diagnostics across the API test tree.
 */
const repositoryBorrowerViolations = (): string[] => {
  const api = new API({ cwd: fileURLToPath(new URL('..', import.meta.url)) });
  try {
    const snapshot = api.updateSnapshot({ openFiles: apiTestFiles.map(({ path }) => path) });
    const violations: string[] = [];
    for (const { file, path } of apiTestFiles) {
      const project = snapshot.getDefaultProjectForFile(path);
      const source = project?.program.getSourceFile(path);
      if (!project || !source) throw new Error(`TypeScript did not load ${file}`);
      violations.push(...borrowerTerminationViolations(source, project.checker, file));
    }
    return violations;
  } finally {
    api.close();
  }
};

describe('shared API test infrastructure lifecycle', () => {
  it('registers shared-infrastructure cleanup in the worker module that owns it', () => {
    const vitestImport = helpersSource.match(/^import\s*\{([^}]*)\}\s*from\s*['"]vitest['"];\s*$/m);
    const owner = helpersSource.search(
      /^export const stopSharedInfra = async \(\): Promise<void> => \{$/m,
    );
    const cleanupHook = helpersSource.search(/^afterAll\(stopSharedInfra\);$/m);

    expect(vitestImport, '_helpers.ts must import lifecycle hooks from vitest').not.toBeNull();
    expect(vitestImport?.[1] ?? '').toMatch(/(?:^|,)\s*afterAll\s*(?:,|$)/);
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(cleanupHook).toBeGreaterThan(owner);
    expect(globalSetupSource).not.toContain('stopSharedInfra');
    expect(globalSetupSource).not.toContain('./_helpers');
  });

  it('returns the cleanup-owned Redis client from raw', () => {
    const ownerStart = helpersSource.search(
      /^const createTestDI = \(logger: pino\.Logger, infra: ResolvedInfra\): DI => \{$/m,
    );
    const ownerEnd = helpersSource.search(/^\/\/ Anything that can run SQL:/m);
    expect(ownerStart).toBeGreaterThanOrEqual(0);
    expect(ownerEnd).toBeGreaterThan(ownerStart);

    const ownerSource = helpersSource.slice(ownerStart, ownerEnd);
    const rawAccessor = ownerSource.match(/^    raw: \(\) => (.+),$/m);
    const ownedShutdown = ownerSource.search(/^      await scopedRedis\.quit\(\);$/m);
    const fixtureCleanup = helpersSource.search(
      /^    cleanup: async \(\) => \{\n      await di\.shutdown\(\);\n    \},$/m,
    );

    expect(rawAccessor, 'createTestDI must define the raw Redis accessor').not.toBeNull();
    expect(ownedShutdown).toBeGreaterThanOrEqual(0);
    expect(fixtureCleanup).toBeGreaterThan(ownerEnd);
    expect(rawAccessor?.[1], 'raw() must return the cleanup-owned scopedRedis client').toBe(
      'scopedRedis',
    );
  });

  // Parsing the entire API test tree can exceed Vitest's default timeout while workspace suites contend for CPU.
  it('forbids borrowers from terminating fixture-owned raw Redis clients', () => {
    // The anchor is the vacuity guard, and it sits on the WALK rather than on the prefiltered list. A clean tree is expected to leave few files carrying `quit`/`disconnect` at all -- that set legitimately shrinks as violations are fixed -- so asserting on it would pin the guard to today's violations. What must never silently become empty is the directory walk that feeds it.
    expect(apiTestTree).toEqual(
      expect.arrayContaining(['routes/accounts.test.ts', 'routes/symbols.test.ts']),
    );
    expect(repositoryBorrowerViolations()).toEqual([]);
  }, 15_000);

  it('resolves plain, typed, parenthesized, inline, and shadowed borrower forms by symbol', () => {
    const fixture = [
      'declare const fx: { di: { redis: { raw(): Redis } } };',
      'declare class Redis { quit(): void; disconnect(): void; }',
      'const plain = fx.di.redis.raw();',
      'plain.quit();',
      'const typed: Redis = fx.di.redis.raw();',
      'typed.disconnect();',
      'const parenthesized = ((fx.di.redis.raw()));',
      'parenthesized.quit();',
      'void fx.di.redis.raw().quit();',
      'let assigned: Redis;',
      'assigned = fx.di.redis.raw();',
      'assigned.disconnect();',
      '{',
      '  const same = fx.di.redis.raw();',
      '  {',
      '    const same = new Redis();',
      '    same.quit();',
      '  }',
      '}',
    ].join('\n');

    expect(virtualBorrowerViolations(fixture)).toEqual([
      'borrower-fixture.ts:4: plain terminates a fixture-owned raw Redis client',
      'borrower-fixture.ts:6: typed terminates a fixture-owned raw Redis client',
      'borrower-fixture.ts:8: parenthesized terminates a fixture-owned raw Redis client',
      'borrower-fixture.ts:9: a fixture-owned raw Redis client is terminated inline',
      'borrower-fixture.ts:12: assigned terminates a fixture-owned raw Redis client',
    ]);
  });

  it('does not claim global teardown or process reaping owns deterministic cleanup', () => {
    expect(helpersSource).not.toContain('global teardown below');
    expect(helpersSource).not.toContain("reaped by testcontainers' Ryuk");
    expect(helpersSource).not.toContain('afterAll is unnecessary because Ryuk reaps the');
  });
});
