import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as ts from 'typescript/unstable/ast';
import { API } from 'typescript/unstable/sync';
import { describe, expect, it } from 'vitest';

import config from '../vitest.config.js';

const TESTS_ROOT = fileURLToPath(new URL('.', import.meta.url));
const DB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES_ROOT = join(TESTS_ROOT, 'fixtures');
const LIFECYCLE_FIXTURE = join(FIXTURES_ROOT, 'infra-lifecycle');
// Contention headroom, not an expectation of how long the work takes. Idle, the four nested `vitest run` cases settle in ~460ms and the two `bun -e` config loads in ~770ms, but 79 files run with `fileParallelism: true` in the db-isolation lane and nothing here is retried, so Vitest's five-second default turns one overrun into a red pipeline with no defect behind it. `packages/config/__tests__/coverage-thresholds.test.ts` states the same budget for a cheaper spawn.
const SPAWN_TIMEOUT_MS = 60_000;

// Both specifiers are assembled at runtime: this guard scans the very directory it lives in, so a literal would make the file an offender of its own scan and the sole-provisioner rule would report itself forever.
const PROVISIONER_SPECIFIER = ['@app', 'testcontainers'].join('/');
const SHARED_MEMO_SPECIFIER = ['./_infra', 'js'].join('.');
const SHARED_MEMO_FILE = '_infra.ts';
const LIFECYCLE_OWNER_FILE = '_global-setup.ts';

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
 * Evaluated in a child process, the way `packages/config/__tests__/coverage-thresholds.test.ts` loads config under a chosen lane. The alternatives both reach outside this file: the package runs under `isolate: false`, so `vi.resetModules()` would drop modules every later file in this worker reuses, and mutating `process.env` in-process would do the same to anything reading it concurrently.
 *
 * @param testcontainers - Value to place in `TESTCONTAINERS`, or `undefined` to unset it entirely.
 * @returns The `fileParallelism` the config resolves to under that environment.
 */
const fileParallelismUnder = (testcontainers: string | undefined): unknown => {
  const env = { ...process.env };
  if (testcontainers === undefined) delete env['TESTCONTAINERS'];
  else env['TESTCONTAINERS'] = testcontainers;

  const script =
    'const config = (await import("./vitest.config.ts")).default;' +
    'console.log("FILE_PARALLELISM=" + JSON.stringify(config.test?.fileParallelism ?? null));';
  const loaded = spawnSync('bun', ['-e', script], { cwd: DB_ROOT, encoding: 'utf8', env });

  expect(loaded.status, loaded.stderr).toBe(0);
  const marker = loaded.stdout.split('\n').find((line) => line.startsWith('FILE_PARALLELISM='));
  expect(marker, loaded.stdout).toBeDefined();
  return JSON.parse(marker!.slice('FILE_PARALLELISM='.length)) as unknown;
};

type LifecycleRun = {
  readonly events: readonly string[];
  readonly status: number | null;
  readonly stderr: string;
};

/**
 * Runs two fixture suites through the real DB helper and global setup while replacing only the Testcontainers boundary with an event logger.
 *
 * @param env - Infrastructure selection passed to the child Vitest process.
 * @returns The child status, stderr, and lifecycle events persisted after global teardown.
 */
const runLifecycleFixture = (env: {
  readonly testcontainers?: '1';
  readonly databaseUrl?: string;
  readonly stopFailure?: string;
}): LifecycleRun => {
  const runDir = mkdtempSync(join(LIFECYCLE_FIXTURE, '.run-'));
  const eventLog = join(runDir, 'events.log');
  const childEnv = { ...process.env };
  delete childEnv['TESTCONTAINERS'];
  delete childEnv['DATABASE_TEST_URL'];
  delete childEnv['INFRA_LIFECYCLE_STOP_FAILURE'];
  if (env.testcontainers) childEnv['TESTCONTAINERS'] = env.testcontainers;
  if (env.databaseUrl) childEnv['DATABASE_TEST_URL'] = env.databaseUrl;
  if (env.stopFailure) childEnv['INFRA_LIFECYCLE_STOP_FAILURE'] = env.stopFailure;
  childEnv['INFRA_LIFECYCLE_LOG'] = eventLog;
  childEnv['EXPECTED_DATABASE_URL'] = env.testcontainers
    ? 'postgres://fixture/shared'
    : (env.databaseUrl ?? '<unset>');

  try {
    const result = spawnSync(
      'bunx',
      [
        'vitest',
        'run',
        '--config',
        join(LIFECYCLE_FIXTURE, 'vitest.config.ts'),
        join(LIFECYCLE_FIXTURE, 'consumer-a.fixture.ts'),
        join(LIFECYCLE_FIXTURE, 'consumer-b.fixture.ts'),
      ],
      {
        cwd: DB_ROOT,
        encoding: 'utf8',
        env: childEnv,
        timeout: 60_000,
      },
    );
    const events = existsSync(eventLog)
      ? readFileSync(eventLog, 'utf8').split('\n').filter(Boolean)
      : [];
    return { events, status: result.status, stderr: result.stderr };
  } finally {
    rmSync(runDir, { force: true, recursive: true });
  }
};

describe('database test hook timeouts', () => {
  it('sets the project hook and teardown timeouts to 180 seconds', () => {
    expect(config.test?.hookTimeout).toBe(180_000);
    // The teardown budget covers `fixture.stop()` shutting down a real container, so it needs the same headroom as the hook that started it. Read through a cast because Vitest types the key as root-only and the resolved project config does not surface it, which is the same reason the config declares it through a `satisfies` variable.
    const teardownTimeout = (config.test as { readonly teardownTimeout?: number } | undefined)
      ?.teardownTimeout;
    expect(teardownTimeout).toBe(180_000);
  });

  // Deliberately the inverse of `apps/api/__tests__/infra-lifecycle-config.test.ts`, which requires `afterAll(stopSharedInfra)` in `_helpers.ts` and forbids the global setup from naming it. The two packages own different problems: api provisions Postgres AND Redis per isolated test file and has not moved to a project-owned fixture, so its teardown still belongs to the module that acquired. This package has one endpoint for the whole project, so file-scoped teardown is exactly the hazard being removed. Moving api across is a separate change; until then a failure on either side is read against its own package's shape, not the other's.
  it('keeps shared-infrastructure teardown in the project lifecycle owner', () => {
    const helperSource = readFileSync(join(TESTS_ROOT, SHARED_MEMO_FILE), 'utf8');
    const configured = config.test?.globalSetup;
    const setupFiles = configured === undefined ? [] : [configured].flat();

    expect(helperSource).not.toMatch(/\bafterAll\s*\(/);
    expect(setupFiles.some((file) => file.endsWith('/_global-setup.ts'))).toBe(true);
  });

  it(
    'serialises the package only when it provisions containers',
    () => {
      // Both branches, because each failure mode is real and they are opposites. Under TESTCONTAINERS=1, every provisioning suite drives the one project-global container endpoint, so the package keeps its scratch-database migration work serial. Without a provisioned container there is no shared local endpoint to protect, and serialising the package only adds wall time.
      expect(fileParallelismUnder('1')).toBe(false);
      expect(fileParallelismUnder(undefined)).toBe(true);
    },
    SPAWN_TIMEOUT_MS,
  );

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

  // The exemption tracks the file that provisions, which is the global setup, not the memo. Pointing it at `_infra.ts` would exempt a file that acquires nothing and force the real owner to obfuscate the specifier to stay green.
  //
  // `fixtures/` is out of scope for the same reason. Nothing there acquires anything: the nested project aliases the specifier to a fake before any of it runs, and the outer project's include never matches those files. Scanning them only made naming the wrapper, in an alias key or a `satisfies` clause, cost a runtime-assembled string, which is a trap for the next reader rather than a rule.
  it('leaves no other file under __tests__ importing the Testcontainers wrapper', () => {
    const strays = allFiles
      .filter((file) => !file.endsWith(LIFECYCLE_OWNER_FILE))
      .filter((file) => !file.startsWith(FIXTURES_ROOT))
      .filter((file) => !provisioningSuites.includes(file))
      .flatMap(provisionerReferences);
    expect(strays).toEqual([]);
  });

  // The negative rule above is only worth having while someone still holds the reference. Deleting the provision would otherwise satisfy every assertion in this file.
  it('acquires infrastructure in the lifecycle owner and nowhere else', () => {
    expect(provisionerReferences(join(TESTS_ROOT, LIFECYCLE_OWNER_FILE))).not.toEqual([]);
    expect(provisionerReferences(join(TESTS_ROOT, SHARED_MEMO_FILE))).toEqual([]);
  });
});

describe('database infrastructure global lifecycle', () => {
  it('configures one shared module graph and one project lifecycle owner', () => {
    const configured = config.test?.globalSetup;
    const setupFiles = configured === undefined ? [] : [configured].flat();

    expect.soft(config.test?.isolate).toBe(false);
    expect.soft(setupFiles.some((file) => file.endsWith('/_global-setup.ts'))).toBe(true);
  });

  it(
    'provisions once, shares the URL across later suites, and stops only after both finish',
    () => {
      const result = runLifecycleFixture({ testcontainers: '1' });

      expect(result.status, result.stderr).toBe(0);
      expect
        .soft(
          result.events.filter((event) => event === 'start'),
          result.events.join(' -> '),
        )
        .toHaveLength(1);
      const consumers = result.events.filter((event) => event.startsWith('consumer-'));
      expect.soft(consumers).toHaveLength(2);
      expect
        .soft(consumers)
        .toEqual(
          expect.arrayContaining([
            'consumer-a:postgres://fixture/shared:<unset>',
            'consumer-b:postgres://fixture/shared:<unset>',
          ]),
        );
      expect.soft(result.events.filter((event) => event === 'stop')).toHaveLength(1);
      expect.soft(result.events.at(-1), result.events.join(' -> ')).toBe('stop');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'provides an external URL without provisioning or stopping a container',
    () => {
      const databaseUrl = 'postgres://external/fixture';
      const result = runLifecycleFixture({ databaseUrl });

      expect(result.status, result.stderr).toBe(0);
      expect(result.events).toEqual(
        expect.arrayContaining([
          `consumer-a:${databaseUrl}:${databaseUrl}`,
          `consumer-b:${databaseUrl}:${databaseUrl}`,
        ]),
      );
      expect(result.events.some((event) => event === 'start' || event === 'stop')).toBe(false);
    },
    SPAWN_TIMEOUT_MS,
  );

  // Named for what the fixture can show: the setup passes the wrapper's answer through without re-deciding. The rule itself, that TESTCONTAINERS=1 wins, belongs to `withPostgres` and is pinned in `packages/testcontainers/__tests__/reusable-endpoint.test.ts`; the fake aliased in here only mirrors it.
  it(
    'hands the suites whatever the wrapper chose when both selectors are present',
    () => {
      const databaseUrl = 'postgres://external/fixture';
      const result = runLifecycleFixture({ testcontainers: '1', databaseUrl });

      expect(result.status, result.stderr).toBe(0);
      expect(result.events).toEqual(
        expect.arrayContaining([
          'start',
          `consumer-a:postgres://fixture/shared:${databaseUrl}`,
          `consumer-b:postgres://fixture/shared:${databaseUrl}`,
          'stop',
        ]),
      );
      expect(result.events.filter((event) => event === 'start')).toHaveLength(1);
      expect(result.events.filter((event) => event === 'stop')).toHaveLength(1);
      expect(result.events.at(-1), result.events.join(' -> ')).toBe('stop');
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    'fails the run when project-owned teardown cannot stop its container',
    () => {
      const result = runLifecycleFixture({
        testcontainers: '1',
        stopFailure: 'fixture stop failed',
      });

      expect(result.status, result.stderr).not.toBe(0);
      expect(result.stderr).toContain('fixture stop failed');
    },
    SPAWN_TIMEOUT_MS,
  );
});
