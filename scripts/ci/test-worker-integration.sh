#!/usr/bin/env bash
set -euo pipefail
# apps/worker integration suites against real Postgres + Redis service
# containers. The suites gate on DATABASE_TEST_URL / REDIS_TEST_URL (see each
# file's `HAS_INFRA`), so no Docker-in-Docker is needed — the service containers
# are the stack, exactly as the apps/api `integration` job does it.
#
# Runs SERIALLY (the `test:integration` package script passes
# --no-file-parallelism): the suites share one database and several
# `truncate ... cascade` their slice, which cannot safely interleave with a
# sibling's fixture. Each suite migrates + resets its own slice, so a fresh
# service container starts clean and the run is order-independent.
#
# Invoked via `bun run` (not `bunx vitest`) ON PURPOSE: `bun run` delegates the
# vitest bin to `node` when it is on PATH, and the job installs nodejs. The
# tick-and-audit suite mocks Binance with nock, whose fetch interception
# (@mswjs/interceptors) throws "Attempted to assign to readonly property" under
# the bun-alpine runtime; running vitest under node avoids it. Same reason the
# `unit` job installs nodejs.
#
# Kept out of the `integration` job (apps/api) because both TRUNCATE their
# database; each job gets its own service container.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start test-worker-integration

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

( cd apps/worker && bun run test:integration )
