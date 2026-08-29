// Audits the worker integration lane's own vitest json report, because a green lane is not evidence that the lane ran.
//
// Three ways it lied. A gated suite resolved to `describe.skip` with no reason recorded anywhere an artifact could carry, so three of twelve files silently stood down and the job still reported success. A broken include glob produced an empty run that `passWithNoTests: true` turned green. And a crash after the last assertion — a teardown that never settled, a connection that kept the process alive — exited nonzero with every test passed, which reads as a flaky infrastructure blip rather than the real defect it is.
//
// Skips are report-only by DEFAULT. A leg without service containers is expected to stand suites down, and failing on that would only make the honest report unusable: the operator sees which files stood down and why, and that is what was missing. A caller that supplies Postgres and Redis itself passes `--forbid-skips` to make a skip fatal instead, because on that lane a stood-down suite is a misconfigured job. See the flag's own rationale at the foot of this file.

interface AssertionResult {
  readonly status?: string;
  readonly ancestorTitles?: readonly string[];
}

interface FileResult {
  readonly name?: string;
  readonly assertionResults?: readonly AssertionResult[];
}

interface VitestReport {
  readonly numFailedTests?: number;
  readonly testResults?: readonly FileResult[];
}

/** The lane owns every suite in this directory; a report carrying fewer of them collected less than the lane claims to cover. */
const INTEGRATION_DIR = 'apps/worker/__tests__/integration/';

const EXPECTED_INTEGRATION_FILES = 11;

/** Written into the suite title by `apps/worker/__tests__/integration/_infra-gate.ts`, since no vitest reporter carries a skip reason of its own. */
const SKIP_MARKER = ' — skipped: ';

const statusArg = process.argv
  .find((arg) => arg.startsWith('--vitest-status='))
  ?.slice('--vitest-status='.length);
// Validated as digits rather than through Number(): Number('') is 0, so a caller passing --vitest-status= from an unset variable would read as a successful run and skip the "vitest died" branch below entirely. An honesty checker's own argument parsing is the last place that may fail open.
if (statusArg === undefined || !/^-?\d+$/.test(statusArg)) {
  console.error('worker-integration: expected --vitest-status=<vitest exit code>');
  process.exit(2);
}
const vitestStatus = Number(statusArg);

const report = (await Bun.stdin.json()) as VitestReport;
const numFailedTests = report.numFailedTests ?? 0;

// Reported before the collection checks: when vitest died, its exit code is the root cause and a truncated report is the symptom.
if (vitestStatus !== 0) {
  console.error(
    `worker-integration: vitest exited ${vitestStatus} with ${numFailedTests} failed tests`,
  );
  if (numFailedTests === 0) {
    console.error(
      'worker-integration: the failure is outside the assertions — a hook that threw (a failed suite reports no failed TESTS), teardown, an unhandled rejection, or a handle that kept the process alive',
    );
  }
  process.exit(1);
}

const integrationFiles = (report.testResults ?? []).filter((file) =>
  (file.name ?? '').replaceAll('\\', '/').includes(INTEGRATION_DIR),
);

if (integrationFiles.length === 0) {
  console.error('worker-integration: report contained no integration test files');
  process.exit(1);
}

if (integrationFiles.length !== EXPECTED_INTEGRATION_FILES) {
  console.error(
    `worker-integration: report contained ${integrationFiles.length} of ${EXPECTED_INTEGRATION_FILES} expected integration files`,
  );
  process.exit(1);
}

/** A file counts as skipped when any of its cases did not run, so a partially-gated suite is as visible as a wholly-gated one. */
const skipped = new Map<string, string>();
for (const file of integrationFiles) {
  const path = (file.name ?? '').replaceAll('\\', '/');
  const relative = path.slice(path.indexOf(INTEGRATION_DIR));
  const cases = file.assertionResults ?? [];
  // A file that reported no cases at all collected nothing. The file-count check above proves only that the file APPEARED in the report, so without this arm an empty suite is indistinguishable from a passing one and the lane counts it among the executed.
  if (cases.length === 0) {
    skipped.set(relative, 'collected no test cases');
    continue;
  }
  const skippedCases = cases.filter((assertion) => assertion.status === 'skipped');
  if (skippedCases.length === 0) continue;

  const titled = skippedCases
    .flatMap((assertion) => assertion.ancestorTitles ?? [])
    .find((title) => title.includes(SKIP_MARKER));
  skipped.set(
    relative,
    titled?.slice(titled.indexOf(SKIP_MARKER) + SKIP_MARKER.length) ?? 'no skip reason',
  );
}

console.log(
  `worker-integration: ${integrationFiles.length} integration files, ${skipped.size} skipped`,
);
for (const [path, reason] of [...skipped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${path}: ${reason}`);
}

// Skips stay report-only by DEFAULT, because the local lane legitimately stands suites down. They are a failure on a lane that supplies the stack itself, and only the caller knows which it is — hence a flag rather than an environment sniff. Without it the checker fails open on the exact condition it exists to catch: drop REDIS_TEST_URL from the CI job and nine of eleven suites gate off, vitest exits 0 because a skip is not a failure, and the lane is green having run two files.
if (process.argv.includes('--forbid-skips') && skipped.size > 0) {
  console.error(
    `worker-integration: ${skipped.size} of ${integrationFiles.length} integration files stood down in a lane that supplies Postgres and Redis itself — the infrastructure is misconfigured, not the tests`,
  );
  process.exit(1);
}
