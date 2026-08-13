#!/usr/bin/env bash
set -euo pipefail
# Required application gate. Owns a disposable Postgres + Redis, migrates, seeds
# one operator offline, points the app's Binance client at a loopback fixture,
# boots the same-origin ROLE=all stack, and runs the P0 journey in every browser
# project. CI supplies the two stores as service containers; locally they are
# throwaway docker containers this script creates and removes.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start app-e2e

wait_container() {
  local name="$1"
  shift
  local deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$name" 2>/dev/null)" != true ]]; then
      docker logs "$name" >&2 || true
      echo "container $name exited before readiness" >&2
      return 1
    fi
    if docker exec "$name" "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  docker logs "$name" >&2 || true
  echo "container $name did not become ready within 60 seconds" >&2
  return 1
}

REPO_ROOT="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
RUN_ROOT="$(mktemp -d "$REPO_ROOT/.app-e2e.XXXXXX")"
PG_CONTAINER=""
REDIS_CONTAINER=""
APP_PID=""
FIXTURE_PID=""

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  # Nothing downstream reads from either process, so no graceful stop is owed.
  [[ -n "$APP_PID" ]] && kill -KILL "$APP_PID" 2>/dev/null
  [[ -n "$FIXTURE_PID" ]] && kill -KILL "$FIXTURE_PID" 2>/dev/null
  [[ -n "$PG_CONTAINER" ]] && docker rm -f "$PG_CONTAINER" >/dev/null 2>&1
  [[ -n "$REDIS_CONTAINER" ]] && docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1
  [[ "$RUN_ROOT" == "$REPO_ROOT"/.app-e2e.* ]] && rm -rf -- "$RUN_ROOT"
  exit "$status"
}
trap cleanup EXIT

cd "$REPO_ROOT"

if [[ -z "${DATABASE_TEST_URL:-}" ]]; then
  PG_CONTAINER="binance-app-e2e-pg-$$"
  docker run --rm -d --name "$PG_CONTAINER" \
    -e POSTGRES_DB=binance_trading_bot_test \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres \
    -e NO_TS_TUNE=1 \
    -p 127.0.0.1::5432 \
    timescale/timescaledb:latest-pg17 >/dev/null
  # -h forces a TCP probe. The entrypoint's init pass runs a socket-only server,
  # so a socket probe reports ready and then the real server restarts under us.
  wait_container "$PG_CONTAINER" \
    pg_isready -h 127.0.0.1 -U postgres -d binance_trading_bot_test
  PG_PORT="$(docker port "$PG_CONTAINER" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/' | head -n 1)"
  DATABASE_TEST_URL="postgres://postgres:postgres@127.0.0.1:${PG_PORT}/binance_trading_bot_test"
fi

if [[ -z "${REDIS_TEST_URL:-}" ]]; then
  REDIS_CONTAINER="binance-app-e2e-redis-$$"
  docker run --rm -d --name "$REDIS_CONTAINER" -p 127.0.0.1::6379 \
    redis:8-alpine >/dev/null
  wait_container "$REDIS_CONTAINER" redis-cli ping
  REDIS_PORT="$(docker port "$REDIS_CONTAINER" 6379/tcp | sed -E 's/.*:([0-9]+)$/\1/' | head -n 1)"
  REDIS_TEST_URL="redis://127.0.0.1:${REDIS_PORT}"
fi

DATABASE_TEST_URL="$DATABASE_TEST_URL" bun scripts/ci/assert-app-e2e-database.ts
export DATABASE_URL="$DATABASE_TEST_URL"
export REDIS_URL="$REDIS_TEST_URL"
export NODE_ENV=test
export AUTH_SECRET=app-e2e-only-auth-secret-0123456789abcdef
export WEB_ORIGIN=http://localhost:53000
export WEB_DIST_DIR="$REPO_ROOT/apps/web/dist"
export ROLE=all
export PORT=53000
export ADMIN_PORT=9100
export ADMIN_HOST=127.0.0.1
export WORKER_ADMIN_PORT=9101
export WORKER_ADMIN_HOST=127.0.0.1
export LIVE_DEMO=0
export APP_E2E=1
export BACKUP_DIR="$RUN_ROOT/backups"
mkdir -p "$BACKUP_DIR"

bun run db:migrate
SEED_APP_E2E=1 \
  SEED_OPERATOR_EMAIL=app-e2e@example.test \
  SEED_OPERATOR_PASSWORD=app-e2e-password \
  SEED_MANIFEST_PATH="$RUN_ROOT/seed.env" \
  bun run seed:dev
# shellcheck source=/dev/null
source "$RUN_ROOT/seed.env"

UNMATCHED_LOG="$RUN_ROOT/unmatched-binance.log"
BINANCE_FIXTURE_MANIFEST_PATH="$RUN_ROOT/binance.env" \
  BINANCE_FIXTURE_UNMATCHED_PATH="$UNMATCHED_LOG" \
  bun e2e/fixtures/binance/server.ts >"$RUN_ROOT/fixture.log" 2>&1 &
FIXTURE_PID=$!
for _ in $(seq 1 100); do
  [[ -s "$RUN_ROOT/binance.env" ]] && break
  kill -0 "$FIXTURE_PID" 2>/dev/null || { cat "$RUN_ROOT/fixture.log" >&2; exit 1; }
  sleep 0.1
done
[[ -s "$RUN_ROOT/binance.env" ]] || { echo 'fixture server did not publish endpoints' >&2; exit 1; }
# shellcheck source=/dev/null
source "$RUN_ROOT/binance.env"

VITE_PWA=0 bun --filter @app/web build
bun apps/server/src/index.ts >"$RUN_ROOT/app.log" 2>&1 &
APP_PID=$!

if ! bun scripts/ci/wait-app-e2e-url.ts http://127.0.0.1:9100/readyz "$APP_PID" 120000 ||
  ! bun scripts/ci/wait-app-e2e-url.ts http://localhost:53000/login "$APP_PID" 120000; then
  cat "$RUN_ROOT/app.log" >&2
  exit 1
fi

set +e
(cd e2e && bun x playwright test --config=playwright.app.config.ts)
STATUS=$?
set -e

if ((STATUS == 0)); then
  bun scripts/ci/check-playwright-honesty.ts --mode=app-required \
    <e2e/test-results/app-results.json || STATUS=$?
fi

# A 501 the app swallowed can leave the journey green, which is exactly the
# failure this check exists to catch.
if [[ -s "$UNMATCHED_LOG" ]]; then
  echo 'app made Binance traffic the fixture does not answer:' >&2
  cat "$UNMATCHED_LOG" >&2
  STATUS=1
fi

exit "$STATUS"
