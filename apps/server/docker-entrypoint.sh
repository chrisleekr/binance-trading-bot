#!/bin/sh
set -eu
# Runs DB migrations before exec'ing the app, so the schema is guaranteed current
# before any request hits a route or the worker ticks. A migration that fails
# exits the container non-zero and readiness never answers, so the orchestrator
# backs off rather than serving with a stale schema.
#
# ROLE=all and ROLE=api migrate on boot. In the split (scale) topology only ONE
# service should migrate: the api service runs migrations, worker/study set
# SKIP_MIGRATIONS=1 so concurrent runners never race on _app_migrations.
#
# Operator's offline-only path is the same binary:
#   docker compose run --rm app bun /app/dist/migrate.js

# Treat SKIP_MIGRATIONS as opt-out only when set to a truthy value.
# `=0` / `=false` would otherwise disable migrations even though the
# operator's intent reads as "run them".
case "${SKIP_MIGRATIONS:-}" in
  1 | true | TRUE | yes | YES)
    echo "[entrypoint] SKIP_MIGRATIONS=$SKIP_MIGRATIONS; skipping"
    ;;
  *)
    echo "[entrypoint] running migrations"
    bun /app/dist/migrate.js
    ;;
esac

exec "$@"
