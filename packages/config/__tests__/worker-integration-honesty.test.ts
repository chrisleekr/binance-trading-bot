import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHECKER = join(REPO_ROOT, 'scripts/ci/check-worker-integration-honesty.ts');
const INTEGRATION_DIR = join(REPO_ROOT, 'apps/worker/__tests__/integration');
const INTEGRATION_REL = 'apps/worker/__tests__/integration';

/** The whole point of the lane is that all twelve suites execute; a report carrying fewer is a broken include glob, which `passWithNoTests: true` would otherwise render green. */
const EXPECTED_INTEGRATION_FILES = 12;

/** Collection-time marker the gated `describe` title carries when its suite is skipped. No vitest API puts a skip reason into an artifact — the junit reporter emits a bare `<skipped/>` keyed on `task.mode`, and `ctx.skip(note)`'s note reaches only the default reporter — so the reason has to ride the suite title, where the json reporter's `assertionResults[].ancestorTitles` preserves it. */
const SKIP_MARKER = ' — skipped: ';

type AssertionResult = {
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly ancestorTitles: readonly string[];
  readonly fullName: string;
  readonly title: string;
};

type FileResult = {
  readonly name: string;
  readonly status: 'passed' | 'failed';
  readonly assertionResults: readonly AssertionResult[];
};

const assertion = (suiteTitle: string, title: string, status: AssertionResult['status']) => ({
  status,
  ancestorTitles: [suiteTitle],
  fullName: `${suiteTitle} ${title}`,
  title,
});

type FileOptions = {
  /** Present means the suite stood down. `null` means it did so without a reason in its title, which no suite produces once it routes through describeInfra, and which the checker must still render rather than drop, so a suite that bypasses the gate stays visible. */
  readonly skipReason?: string | null;
  /** Reports the file with an empty `assertionResults`, i.e. it appeared in the report having collected nothing. */
  readonly emptyCases?: boolean;
};

/**
 * Builds one `testResults[]` entry shaped like vitest 4's json reporter, so the checker under test parses the same structure CI feeds it.
 *
 * @param relPath - Repo-relative path the entry reports as its file; the checker keys its integration-file count off this.
 * @param options - Which stand-down shape to emit, if any; an entry with no options reports two passing cases.
 * @returns One report entry, ready to be wrapped by `reportFor`.
 */
const fileResult = (relPath: string, options: FileOptions = {}): FileResult => {
  const base = 'gated suite';
  const skipped = 'skipReason' in options;
  const suiteTitle = options.skipReason ? `${base}${SKIP_MARKER}${options.skipReason}` : base;

  return {
    name: join(REPO_ROOT, relPath),
    status: 'passed',
    assertionResults: options.emptyCases
      ? []
      : [
          assertion(suiteTitle, 'first case', skipped ? 'skipped' : 'passed'),
          assertion(suiteTitle, 'second case', skipped ? 'skipped' : 'passed'),
        ],
  };
};

/**
 * Wraps file entries in the top-level counts vitest 4's json reporter emits, so the checker's aggregate reads see a self-consistent report.
 *
 * @param files - The `testResults[]` entries, in any number; the empty list is the broken-glob case the checker must refuse.
 * @param counts - Overrides for the aggregate fields; `numFailedTests` drives the checker's "real assertion failure" branch.
 * @returns A report object the checker accepts on stdin.
 */
const reportFor = (
  files: readonly FileResult[],
  counts: { readonly numFailedTests?: number } = {},
): object => {
  const numFailedTests = counts.numFailedTests ?? 0;
  const assertions = files.flatMap((file) => file.assertionResults);

  return {
    numTotalTestSuites: files.length,
    numTotalTests: assertions.length,
    numFailedTests,
    numPassedTests: assertions.filter((a) => a.status === 'passed').length,
    numPendingTests: assertions.filter((a) => a.status === 'skipped').length,
    numTodoTests: 0,
    success: numFailedTests === 0,
    startTime: 0,
    testResults: files,
  };
};

const integrationFiles = (): string[] =>
  existsSync(INTEGRATION_DIR)
    ? readdirSync(INTEGRATION_DIR)
        .filter((entry) => entry.endsWith('.test.ts'))
        .sort()
    : [];

/**
 * Builds a report covering every suite the lane currently owns, so a case states only the entry it cares about.
 *
 * @param overrides - Keyed by integration test file NAME, not index; the matching entry is rebuilt with the given stand-down shape while the rest stay passing.
 * @returns The full-lane report.
 */
const fullReport = (overrides: Record<string, FileOptions> = {}) =>
  reportFor(
    integrationFiles().map((file) =>
      fileResult(`${INTEGRATION_REL}/${file}`, overrides[file] ?? {}),
    ),
  );

const check = (report: object, vitestStatus = 0, extraArgs: readonly string[] = []) =>
  spawnSync('bun', [CHECKER, `--vitest-status=${vitestStatus}`, ...extraArgs], {
    cwd: REPO_ROOT,
    input: JSON.stringify(report),
    encoding: 'utf8',
  });

describe('worker integration lane honesty', () => {
  it('accepts a report where every integration file executed', () => {
    const result = check(fullReport());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('worker-integration: 12 integration files, 0 skipped');
  });

  // The deliverable of the whole lane: a stand-down that is visible AND says what it was missing. junit emits a bare <skipped/>, so without the title there is no artifact CI keeps that carries a reason.
  it('reports a skipped integration file together with its skip reason', () => {
    const result = check(
      fullReport({
        'resolve-profile.test.ts': {
          skipReason: 'TESTCONTAINERS=1 or DATABASE_TEST_URL required',
        },
      }),
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('worker-integration: 12 integration files, 1 skipped');
    expect(result.stdout).toContain(
      `  ${INTEGRATION_REL}/resolve-profile.test.ts: TESTCONTAINERS=1 or DATABASE_TEST_URL required`,
    );
  });

  // A suite skipped without a reason must be visibly reason-less rather than silently omitted, or the count and the explanation disagree and the report reads as though nothing stood down.
  it('reports a skipped integration file that carries no reason as reason-less', () => {
    const result = check(fullReport({ 'resolve-profile.test.ts': { skipReason: null } }));

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('worker-integration: 12 integration files, 1 skipped');
    expect(result.stdout).toContain(`  ${INTEGRATION_REL}/resolve-profile.test.ts: no skip reason`);
  });

  // Skips are report-only by default because the local lane legitimately stands suites down; the CI lane supplies both service containers, so a skip there is a misconfigured job and the flag is how that lane says so.
  it('rejects a skipped integration file under --forbid-skips', () => {
    const report = fullReport({
      'resolve-profile.test.ts': {
        skipReason: 'needs Docker via TESTCONTAINERS=1, or DATABASE_TEST_URL',
      },
    });

    expect(check(report).status, 'report-only by default').toBe(0);

    const strict = check(report, 0, ['--forbid-skips']);
    expect(strict.status).not.toBe(0);
    expect(strict.stderr).toContain(
      'worker-integration: 1 of 12 integration files stood down in a lane that supplies Postgres and Redis itself',
    );
  });

  // A file present in the report but carrying no cases collected nothing. The file-count check above proves only that it appeared, so without its own arm an empty suite reads as a passing one.
  it('reports a file that collected no test cases rather than counting it as executed', () => {
    const report = fullReport({ 'resolve-profile.test.ts': { emptyCases: true } });
    const result = check(report);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('worker-integration: 12 integration files, 1 skipped');
    expect(result.stdout).toContain(
      `  ${INTEGRATION_REL}/resolve-profile.test.ts: collected no test cases`,
    );
  });

  // The lane died in teardown: every assertion passed and the process still exited nonzero, which a report that only counts failures reads as a clean run.
  it('rejects a nonzero vitest status with zero failed tests, naming that condition', () => {
    const result = check(fullReport(), 3);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('worker-integration: vitest exited 3 with 0 failed tests');
  });

  // A genuine assertion failure must not be reported as the outside-the-assertions condition, or the two causes share one diagnosis and the operator is sent to the wrong place.
  it('rejects a nonzero vitest status with failed tests without the outside-assertions diagnostic', () => {
    const report = reportFor(
      integrationFiles().map((file) => fileResult(`${INTEGRATION_REL}/${file}`)),
      { numFailedTests: 2 },
    );
    const result = check(report, 1);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('worker-integration: vitest exited 1 with 2 failed tests');
    expect(result.stderr).not.toContain('0 failed tests');
  });

  // The marker is the whole channel. junit emits a bare <skipped/> and ctx.skip(note) reaches only the default reporter, so the suite TITLE is the one artifact CI keeps that can carry a reason — which makes the separator a cross-process contract between a producer that writes it inline and two consumers that each declare their own copy. Nothing else ties the three together, so an ordinary edit to the em-dash or a dropped space turns every real stand-down into "no skip reason" with the lane still green: the exact shape of report this gate exists to refuse. Pinned against the producer's source the way EXPECTED_INTEGRATION_FILES is pinned against the checker's.
  it('pins the skip marker the suite gate writes to the one the checker reads', () => {
    const gateSource = readFileSync(join(INTEGRATION_DIR, '_infra-gate.ts'), 'utf8');
    const checkerSource = readFileSync(CHECKER, 'utf8');

    expect(gateSource).toContain(`\${title}${SKIP_MARKER}\${gate.reason}`);
    expect(checkerSource).toContain(`const SKIP_MARKER = '${SKIP_MARKER}';`);
  });

  // The checker's own argument parsing is the last place that may fail open, and it exits 2 rather than 1 so a wiring mistake is distinguishable from a real refusal. Number('') is 0, so validating through Number would read a flag passed from an unset variable as a successful run and skip the "vitest died" branch entirely.
  it('refuses to audit a report when the vitest exit code is absent or not a number', () => {
    const bare = spawnSync('bun', [CHECKER], {
      cwd: REPO_ROOT,
      input: JSON.stringify(reportFor([])),
      encoding: 'utf8',
    });
    expect(bare.status).toBe(2);
    expect(bare.stderr).toContain('worker-integration: expected --vitest-status=');

    const empty = spawnSync('bun', [CHECKER, '--vitest-status='], {
      cwd: REPO_ROOT,
      input: JSON.stringify(reportFor([])),
      encoding: 'utf8',
    });
    expect(empty.status).toBe(2);
  });

  // `passWithNoTests: true` makes a broken include glob exit zero with an empty report, so the lane is green precisely when it ran nothing.
  it('rejects a report containing no integration files at all', () => {
    const result = check(reportFor([fileResult('apps/worker/__tests__/env.test.ts')]));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'worker-integration: report contained no integration test files',
    );
  });

  // A partially-collected report is a narrowed glob rather than a broken one, and it carries its own sentence: both exit nonzero, so only the text says which happened.
  it('rejects a report containing fewer integration files than the lane owns', () => {
    const partial = integrationFiles()
      .slice(0, -1)
      .map((file) => fileResult(`${INTEGRATION_REL}/${file}`));
    const result = check(reportFor(partial));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'worker-integration: report contained 11 of 12 expected integration files',
    );
  });

  // Without this the twelve above is a number the checker asserts against itself.
  it('pins the expected file count to what the integration directory actually holds', () => {
    const source = existsSync(CHECKER) ? readFileSync(CHECKER, 'utf8') : '';
    const pinned = /EXPECTED_INTEGRATION_FILES = (\d+)/.exec(source)?.[1];

    expect(integrationFiles()).toHaveLength(EXPECTED_INTEGRATION_FILES);
    expect(pinned, `${CHECKER} must pin EXPECTED_INTEGRATION_FILES`).toBe(
      String(EXPECTED_INTEGRATION_FILES),
    );
  });
});

/** Blanks comments in place so line numbers survive and a `TESTCONTAINERS` mentioned only in prose cannot satisfy the gate check. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const READS_TESTCONTAINERS = /process\.env(?:\[['"]TESTCONTAINERS['"]\]|\.TESTCONTAINERS\b)/;

/** A suite can obtain its gate from a sibling module in the same directory, so the answer is the union of the file and every relative import it makes within the integration directory. */
const gateSources = (file: string): string[] => {
  const source = stripComments(readFileSync(join(INTEGRATION_DIR, file), 'utf8'));
  const sources = [source];

  for (const match of source.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)) {
    const specifier = match[1]!.replace(/\.js$/, '');
    for (const candidate of [`${specifier}.ts`, specifier]) {
      const path = join(INTEGRATION_DIR, candidate);
      if (existsSync(path)) sources.push(stripComments(readFileSync(path, 'utf8')));
    }
  }

  return sources;
};

describe('worker integration infra gates', () => {
  // Docker alone must be enough to run the whole lane. One of the three predicates those twelve gates had drifted into read no TESTCONTAINERS branch at all, so the two suites using it stood down on a machine that could have run them and the lane still reported green.
  it('gates every integration suite on TESTCONTAINERS so the lane runs with Docker alone', () => {
    const files = integrationFiles();

    expect(files).toHaveLength(EXPECTED_INTEGRATION_FILES);
    expect(files).toContain('boot-context.test.ts');

    const ungated = files.filter(
      (file) => !gateSources(file).some((source) => READS_TESTCONTAINERS.test(source)),
    );

    expect(
      ungated,
      'these integration suites read no TESTCONTAINERS branch, so TESTCONTAINERS=1 skips them',
    ).toEqual([]);
  });
});
