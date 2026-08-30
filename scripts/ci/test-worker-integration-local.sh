#!/usr/bin/env bash
set -euo pipefail
# The documented way to run the apps/worker integration lane on a laptop.
#
# CI supplies Postgres and Redis as service containers; locally there are none, so this runs under TESTCONTAINERS=1 and lets `@app/testcontainers` provision throwaway ones. That needs a reachable Docker daemon, and without one testcontainers fails deep inside a `beforeAll` with a socket error that reads like a broken test. Probing up front turns that into one sentence naming the actual prerequisite.
#
# An operator who already has Postgres and Redis running can point DATABASE_TEST_URL + REDIS_TEST_URL at them and skip Docker entirely. That path has to leave TESTCONTAINERS unset rather than merely set the URLs: `withPostgres` / `withRedis` treat TESTCONTAINERS=1 as winning over a reuse URL, so hardcoding it here would provision anyway and the reuse the operator asked for would never happen.
#
# A missing Docker daemon exits 0 on purpose: this is a local convenience command, and the machine simply cannot run the lane. The honesty check is what stops a genuinely executed run from over-claiming.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start test-worker-integration-local

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"

if [ -n "${DATABASE_TEST_URL:-}" ] && [ -n "${REDIS_TEST_URL:-}" ]; then
  USE_TESTCONTAINERS=0
elif docker info >/dev/null 2>&1; then
  USE_TESTCONTAINERS=1
else
  echo 'worker-integration: skipped, no reachable Docker daemon. Start Docker (or point DATABASE_TEST_URL + REDIS_TEST_URL at a running Postgres + Redis and re-run) to execute the lane.'
  exit 0
fi

REPORT="$REPO_ROOT/apps/worker/test-results/vitest-results.json"
rm -f "$REPORT"
STATUS=0
( cd "$REPO_ROOT/apps/worker" && TESTCONTAINERS="$USE_TESTCONTAINERS" bun x vitest run __tests__/integration \
  --no-file-parallelism --hookTimeout=180000 \
  --reporter=default --reporter=json \
  --outputFile.json=test-results/vitest-results.json ) || STATUS=$?

# The redirection below cannot report its own absence: vitest dying before the reporter runs leaves no file, bash fails the redirect, and the checker never starts to say why. A missing report is never evidence of a clean lane, so it is fatal even on a zero exit — the one case where falling through would be silently green. Stale reports are removed before the run so this check reads THIS run's artifact rather than the last one's.
if [ ! -s "$REPORT" ]; then
  echo "worker-integration: vitest exited $STATUS without writing $REPORT — it died before the reporter ran, so there is no report to audit" >&2
  if [ "$STATUS" -eq 0 ]; then STATUS=1; fi
  exit "$STATUS"
fi

bun "$REPO_ROOT/scripts/ci/check-worker-integration-honesty.ts" --vitest-status="$STATUS" \
  <"$REPORT" || STATUS=$?

exit "$STATUS"
