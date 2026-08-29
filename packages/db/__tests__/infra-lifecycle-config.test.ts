import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { describe, expect, it, vi } from 'vitest';

import config from '../vitest.config.js';

const TESTS_ROOT = fileURLToPath(new URL('.', import.meta.url));

// Both specifiers are assembled at runtime: this guard scans the very directory it lives in, so a literal would make the file an offender of its own scan and the sole-provisioner rule would report itself forever.
const PROVISIONER_SPECIFIER = ['@app', 'testcontainers'].join('/');
const SHARED_MEMO_SPECIFIER = ['./_infra', 'js'].join('.');
const SHARED_MEMO_FILE = '_infra.ts';

/**
 * Collects every TypeScript file under `packages/db/__tests__` so the rules below apply to whatever the directory actually holds, not to a list that silently stops covering new suites.
 *
 * @param dir - Absolute directory to descend from.
 * @returns Absolute paths of every `.ts` file beneath `dir`, in directory order.
 */
const tsFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });

const allFiles = tsFiles(TESTS_ROOT);
const sources = new Map(allFiles.map((file) => [file, readFileSync(file, 'utf8')]));

/**
 * Renders an absolute path relative to the test root so failures name a file the way the repository does.
 *
 * @param file - Absolute path inside `packages/db/__tests__`.
 * @returns The path relative to that directory.
 */
const rel = (file: string): string => relative(TESTS_ROOT, file);

// A suite provisions infrastructure if it names either the shared memo or the raw Testcontainers wrapper. Deriving the list rather than hardcoding it means a new provisioning suite inherits every rule below on the day it is written.
const provisioningSuites = allFiles.filter(
  (file) =>
    file.endsWith('.test.ts') &&
    (sources.get(file)?.includes(SHARED_MEMO_SPECIFIER) === true ||
      sources.get(file)?.includes(PROVISIONER_SPECIFIER) === true),
);

// Anchors keep the walk honest: a narrowed scan would still satisfy a non-empty floor, so the two suites that have always provisioned are named explicitly.
const ANCHORS = ['better-auth-1-7-migration.test.ts', 'migrate-immutability.test.ts'] as const;

/**
 * Locates direct references to the Testcontainers wrapper. Reporting `file:line` rather than asserting over the file body keeps a failure readable: a whole migration suite rendered as an inline diff buries the one line that matters.
 *
 * @param file - Absolute path of the file to scan.
 * @returns One `path:line` entry per line naming the wrapper.
 */
const provisionerReferences = (file: string): string[] =>
  (sources.get(file) ?? '')
    .split('\n')
    .flatMap((line, index) =>
      line.includes(PROVISIONER_SPECIFIER) ? [`${rel(file)}:${index + 1}`] : [],
    );

/**
 * Counts the arguments on every executable `beforeAll` call in one test file so comments and alternate timeout literals cannot satisfy the invariant.
 *
 * @param file - Absolute test-file path parsed by the TypeScript project service.
 * @returns One argument count per `beforeAll` call in source order.
 */
const beforeAllArgumentCounts = (file: string): number[] => {
  const api = new API({ cwd: fileURLToPath(new URL('..', import.meta.url)) });
  try {
    const snapshot = api.updateSnapshot({ openFiles: [file] });
    const project = snapshot.getDefaultProjectForFile(file);
    const source = project?.program.getSourceFile(file);
    if (!source) throw new Error(`TypeScript did not load ${file}`);

    const counts: number[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'beforeAll'
      ) {
        counts.push(node.arguments.length);
      }
      node.forEachChild(visit);
    };
    visit(source);
    return counts;
  } finally {
    api.close();
  }
};

/**
 * Re-evaluates the project config under a chosen `TESTCONTAINERS` value. The setting is resolved once at import time, so reading the ambient module would pin only whichever branch the runner happened to start in and leave the other free to be inverted.
 *
 * @param testcontainers - Value to place in `TESTCONTAINERS`, or `undefined` to unset it entirely.
 * @returns The `fileParallelism` the config resolves to under that environment.
 */
const fileParallelismUnder = async (
  testcontainers: string | undefined,
): Promise<boolean | undefined> => {
  const previous = process.env['TESTCONTAINERS'];
  if (testcontainers === undefined) delete process.env['TESTCONTAINERS'];
  else process.env['TESTCONTAINERS'] = testcontainers;
  try {
    vi.resetModules();
    return (await import('../vitest.config.js')).default.test?.fileParallelism;
  } finally {
    if (previous === undefined) delete process.env['TESTCONTAINERS'];
    else process.env['TESTCONTAINERS'] = previous;
  }
};

describe('database test hook timeouts', () => {
  it('sets the project hook timeout to 180 seconds', () => {
    expect(config.test?.hookTimeout).toBe(180_000);
  });

  // The headline claim of `_infra.ts` is that teardown lives OUTSIDE the hook that acquires, so a timed-out `beforeAll` cannot orphan a container. That claim rests entirely on this one registration: delete it and every suite in the package still passes while each `TESTCONTAINERS=1` file leaks a Postgres. The api side already pins its equivalent, and the two guards should not disagree.
  it('registers shared-infrastructure cleanup at file scope in the module that owns it', () => {
    const source = readFileSync(join(TESTS_ROOT, SHARED_MEMO_FILE), 'utf8');
    const owner = source.search(
      /^export const stopSharedInfra = async \(\): Promise<void> => \{$/m,
    );
    const hook = source.search(/^afterAll\(stopSharedInfra\);$/m);

    expect(owner).toBeGreaterThanOrEqual(0);
    // After the owner and at column zero, i.e. module scope rather than nested inside any suite hook.
    expect(hook).toBeGreaterThan(owner);
  });

  it('serialises the package only when it provisions containers', async () => {
    // Both branches, because each failure mode is real and they are opposites. Left unarmed under TESTCONTAINERS=1, seven suites race one Docker daemon and orphan what they start. Armed unconditionally, every Docker-free lane pays roughly 3x wall clock to serialise 78 files over zero containers.
    expect(await fileParallelismUnder('1')).toBe(false);
    expect(await fileParallelismUnder(undefined)).toBe(true);
  });

  it('reaches every provisioning suite in the directory', () => {
    expect(allFiles.length).toBeGreaterThan(0);
    expect(provisioningSuites.map(rel).sort()).toEqual(expect.arrayContaining([...ANCHORS]));
  });

  it.each(provisioningSuites.map(rel))(
    '%s setup inherits the project hook timeout',
    (name) => {
      expect(beforeAllArgumentCounts(join(TESTS_ROOT, name))).toEqual([1]);
    },
    60_000,
  );
});

describe('database infrastructure provisioning', () => {
  it.each(provisioningSuites.map(rel))(
    '%s provisions through the shared memo, never the wrapper directly',
    (name) => {
      expect(provisionerReferences(join(TESTS_ROOT, name))).toEqual([]);
    },
  );

  it('leaves no other file under __tests__ importing the Testcontainers wrapper', () => {
    const strays = allFiles
      .filter((file) => !file.endsWith(SHARED_MEMO_FILE))
      .filter((file) => !provisioningSuites.includes(file))
      .flatMap(provisionerReferences);
    expect(strays).toEqual([]);
  });
});
