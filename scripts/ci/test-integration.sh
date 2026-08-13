#!/usr/bin/env bash
set -euo pipefail
# apps/api integration suites against the real Postgres + Redis service
# containers, plus the @app/testcontainers wrapper's own tests.
#
# DATABASE_TEST_URL / REDIS_TEST_URL are what apps/api/__tests__/_helpers.ts
# gates on (HAS_INFRA). The job used to export DATABASE_URL / REDIS_URL instead,
# so every DB-backed suite resolved as `describe.skip` and the pipeline reported
# green over 255 unrun tests. Both names are declared in turbo.json's `test.env`;
# turbo's strict envMode strips anything undeclared before vitest ever sees it.
#
# No Docker-in-Docker here, so TESTCONTAINERS stays unset and the wrapper verifies
# that it reuses the service-container endpoints supplied by this lane.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start test-integration
export COVERAGE_LANE=integration

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

TESTCONTAINERS_CONTENTION_CHECK=1 bunx turbo test --filter '@app/testcontainers' --filter '@app/api' -- --coverage
