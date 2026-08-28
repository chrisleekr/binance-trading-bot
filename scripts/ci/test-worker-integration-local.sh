#!/usr/bin/env bash
set -euo pipefail
# The documented way to run the apps/worker integration lane on a laptop.
#
# CI supplies Postgres and Redis as service containers; locally there are none, so this runs under TESTCONTAINERS=1 and lets `@app/testcontainers` provision throwaway ones. That needs a reachable Docker daemon, and without one testcontainers fails deep inside a `beforeAll` with a socket error that reads like a broken test. Probing up front turns that into one sentence naming the actual prerequisite.
#
# A missing Docker daemon exits 0 on purpose: this is a local convenience command, and the machine simply cannot run the lane. The honesty check is what stops a genuinely executed run from over-claiming.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start test-worker-integration-local

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"

if ! docker info >/dev/null 2>&1; then
  echo 'worker-integration: skipped, no reachable Docker daemon. Start Docker (or point DATABASE_TEST_URL + REDIS_TEST_URL at a running Postgres + Redis and re-run) to execute the lane.'
  exit 0
fi

STATUS=0
( cd "$REPO_ROOT/apps/worker" && TESTCONTAINERS=1 bun x vitest run __tests__/integration \
  --no-file-parallelism --hookTimeout=180000 \
  --reporter=default --reporter=json \
  --outputFile.json=test-results/vitest-results.json ) || STATUS=$?

bun "$REPO_ROOT/scripts/ci/check-worker-integration-honesty.ts" --vitest-status="$STATUS" \
  <"$REPO_ROOT/apps/worker/test-results/vitest-results.json" || STATUS=$?

exit "$STATUS"
