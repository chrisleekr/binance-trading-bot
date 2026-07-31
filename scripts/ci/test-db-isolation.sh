#!/usr/bin/env bash
set -euo pipefail
# packages/db isolation + projection tests against the real Postgres service.
# DATABASE_TEST_URL points at the service's POSTGRES_DB, which already exists,
# so migrate() (advisory-locked) just applies the schema. Without the variable
# the same suites resolve as describe.skip, so they run only here.
# shellcheck source=_common.sh
source "$(dirname "$0")/_common.sh"
ci::start test-db-isolation

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

bunx turbo test --filter '@app/db'
