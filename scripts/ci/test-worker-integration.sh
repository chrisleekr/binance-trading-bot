#!/usr/bin/env bash
set -euo pipefail
# apps/worker integration suites against real Postgres + Redis service containers. Each suite admits itself through `describeInfra`, which takes DATABASE_TEST_URL / REDIS_TEST_URL as readily as it takes a Docker daemon, so no Docker-in-Docker is needed — the service containers are the stack, exactly as the apps/api `integration` job does it. On a laptop, run `bun run test:worker-integration` instead: it provisions the same stack.
#
# Runs the complete worker suite serially: the tests share one database and several `truncate ... cascade` their slice, which cannot safely interleave with a sibling's fixture. Each suite migrates + resets its own slice, so a fresh service container starts clean and the run is order-independent.
#
# Bun 1.4.0 passes the nock-backed tick-and-audit tests but recursively overflows the stack while merging v8 coverage, so this lane runs vitest under Node: the vitest binary delegates to node when it is on PATH, which is why the job installs nodejs and why removing that step would silently move the lane back onto Bun.
#
# Kept out of the `integration` job (apps/api) because both TRUNCATE their database; each job gets its own service container.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start test-worker-integration
export COVERAGE_LANE=worker-integration

# Wait for Postgres to accept queries. GitLab's TCP port check races the
# service's init, so the job can start before the server is really up. Poll a
# real `select 1` until it succeeds. Run from packages/db so `pg` resolves
# (hoisted under that package).
( cd packages/db && bun -e '
  const { Client } = await import("pg");
  const url = process.env.DATABASE_TEST_URL;
  for (let i = 0; i < 60; i++) {
    const c = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
      await c.connect();
      await c.query("select 1");
      await c.end();
      console.log(`postgres ready after ${i}s`);
      process.exit(0);
    } catch {
      try { await c.end(); } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error("postgres did not accept connections within 60s");
  process.exit(1);
' )

REPORT=apps/worker/test-results/vitest-results.json
rm -f "$REPORT"
# `--reporter` on the CLI REPLACES the config's list rather than adding to it, so junit is re-specified here or the artifact the coverage jobs collect disappears. The json report is what the honesty check reads: it is the only vitest artifact that carries a suite title (and therefore a skip reason) and a failed-test count.
set +e
( cd apps/worker && bun x vitest run --no-file-parallelism --hookTimeout=180000 --coverage \
  --reporter=default --reporter=junit --reporter=json \
  --outputFile.junit=test-results/junit.xml \
  --outputFile.json=test-results/vitest-results.json )
STATUS=$?
set -e

# Runs whatever vitest's exit code was: a lane that dies with every assertion passed is exactly the condition this check names, so gating it on success would blind it to that case.
# The redirection below cannot report its own absence: vitest dying before the reporter runs leaves no file, bash fails the redirect, and the checker never starts to say why. A missing report is never evidence of a clean lane, so it is fatal even on a zero exit — the one case where falling through would be silently green. Stale reports are removed before the run so this check reads THIS run's artifact rather than the last one's.
if [ ! -s "$REPORT" ]; then
  echo "worker-integration: vitest exited $STATUS without writing $REPORT — it died before the reporter ran, so there is no report to audit" >&2
  if [ "$STATUS" -eq 0 ]; then STATUS=1; fi
  exit "$STATUS"
fi

bun scripts/ci/check-worker-integration-honesty.ts --vitest-status="$STATUS" --forbid-skips \
  <"$REPORT" || STATUS=$?

exit "$STATUS"
