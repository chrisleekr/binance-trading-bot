// Audits the complete worker lane's own vitest json report, because a green lane is not evidence that the lane ran.
//
// Four ways it lied. A gated suite resolved to `describe.skip` with no reason recorded anywhere an artifact could carry. A report entry with no cases counted as a passing file. A narrowed include glob still reported success. And a crash after the last assertion exited nonzero with every test passed, which reads as an infrastructure blip rather than the real defect it is.
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

/** Every reported file under this root is part of the complete worker lane, including the integration subset with its exact invariant. */
const WORKER_TEST_DIR = 'apps/worker/__tests__/';

const EXPECTED_INTEGRATION_FILES = 12;

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

const nonIntegrationFloorArg = process.argv
  .find((arg) => arg.startsWith('--min-non-integration-files='))
  ?.slice('--min-non-integration-files='.length);
if (nonIntegrationFloorArg !== undefined && !/^\d+$/.test(nonIntegrationFloorArg)) {
  console.error('worker-integration: expected --min-non-integration-files=<count>');
  process.exit(2);
}
const minNonIntegrationFiles =
  nonIntegrationFloorArg === undefined ? null : Number(nonIntegrationFloorArg);

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

const workerFiles = (report.testResults ?? []).filter((file) =>
  (file.name ?? '').replaceAll('\\', '/').includes(WORKER_TEST_DIR),
);
const integrationFiles = workerFiles.filter((file) =>
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

const nonIntegrationFiles = workerFiles.filter(
  (file) => !(file.name ?? '').replaceAll('\\', '/').includes(INTEGRATION_DIR),
);

/**
 * Renders a reported worker test path relative to the repository so every refusal names the file in the same stable form.
 *
 * @param file - One Vitest JSON file result known to be under the worker test root.
 * @returns The repository-relative worker test path.
 */
const relativeWorkerPath = (file: FileResult): string => {
  const path = (file.name ?? '').replaceAll('\\', '/');
  return path.slice(path.indexOf(WORKER_TEST_DIR));
};

const emptyFiles = workerFiles.filter((file) => (file.assertionResults ?? []).length === 0);
if (emptyFiles.length > 0) {
  console.error('worker-integration: reported worker files collected no test cases:');
  for (const file of emptyFiles.sort((a, b) =>
    relativeWorkerPath(a).localeCompare(relativeWorkerPath(b)),
  )) {
    console.error(`  ${relativeWorkerPath(file)}: collected no test cases`);
  }
  process.exit(1);
}

if (minNonIntegrationFiles !== null && nonIntegrationFiles.length < minNonIntegrationFiles) {
  console.error(
    `worker-integration: report contained ${nonIntegrationFiles.length} non-integration worker files, below the ${minNonIntegrationFiles}-file floor`,
  );
  process.exit(1);
}

/** A file counts as skipped when any of its cases did not run, so a partially-gated suite is as visible as a wholly-gated one. */
const skipped = new Map<string, string>();
for (const file of workerFiles) {
  const relative = relativeWorkerPath(file);
  const cases = file.assertionResults ?? [];
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

const reportScope =
  workerFiles.length === integrationFiles.length
    ? `${integrationFiles.length} integration files`
    : `${workerFiles.length} worker files`;
console.log(`worker-integration: ${reportScope}, ${skipped.size} skipped`);
for (const [path, reason] of [...skipped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${path}: ${reason}`);
}

// Skips stay report-only by DEFAULT, because the local lane legitimately stands suites down. They are a failure on a lane that supplies the stack itself, and only the caller knows which it is — hence a flag rather than an environment sniff. Without it the checker fails open on the exact condition it exists to catch: drop REDIS_TEST_URL from the CI job and nine of eleven suites gate off, vitest exits 0 because a skip is not a failure, and the lane is green having run two files.
//
// The two scopes get separate diagnoses. Only the gated suites under the integration directory read their admission off DATABASE_TEST_URL / REDIS_TEST_URL, so naming the infrastructure is the right first place to look for those and the wrong one for a unit file, which stands down because someone wrote it that way.
if (process.argv.includes('--forbid-skips') && skipped.size > 0) {
  const gated = [...skipped.keys()].filter((path) => path.startsWith(INTEGRATION_DIR));
  const ungated = [...skipped.keys()].filter((path) => !path.startsWith(INTEGRATION_DIR));
  if (gated.length > 0) {
    console.error(
      `worker-integration: ${gated.length} of ${reportScope} stood down in a lane that supplies Postgres and Redis itself — the infrastructure is misconfigured, not the tests`,
    );
  }
  if (ungated.length > 0) {
    console.error(
      `worker-integration: ${ungated.length} of ${reportScope} stood down outside ${INTEGRATION_DIR} in a lane that forbids skips — these files admit themselves without a service container, so the stand-down is in the test`,
    );
  }
  process.exit(1);
}
