import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { migrate } from '../src/migrate.js';

const TEST_DB_URL = process.env['DATABASE_TEST_URL'];
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

/**
 * Concurrent migrators must not race on non-transactional DDL. Without the
 * advisory lock in migrate(), N callers starting from an empty database all
 * read an un-migrated state and race on `create type`, throwing a
 * pg_type_typname_nsp_index duplicate-key. This guards the lock so the
 * parallel vitest workers that share a test DB stay safe. Confirmed RED:
 * removing the pg_advisory_lock line in migrate.ts fails this every run.
 */
describeIfDb('migrate concurrency', () => {
  // A unique throwaway database so concurrent migrators start un-migrated.
  const dbName = `bt_migrate_concurrency_${randomUUID().replace(/-/g, '')}`;
  // describe.skip still runs this body to collect tests, so parse a valid
  // fallback when unset (the skipped hooks never use it) to avoid a throw.
  const baseUrl = TEST_DB_URL ?? 'postgres://localhost/postgres';
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = '/postgres';
  const targetUrl = new URL(baseUrl);
  targetUrl.pathname = `/${dbName}`;

  const withAdmin = async (sql: string): Promise<void> => {
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await admin.query(sql);
    } finally {
      await admin.end();
    }
  };

  beforeAll(async () => {
    await withAdmin(`create database "${dbName}"`);
  });

  afterAll(async () => {
    // `with (force)` terminates any stray session so the drop cannot flake on
    // object_in_use (Postgres 13+; the CI/dev service is pg17).
    await withAdmin(`drop database if exists "${dbName}" with (force)`);
  });

  // Eight racers serialize behind the advisory lock, so the winner applies the
  // whole migration set on an empty database while the rest wait. That cost
  // grows with every new NNNN_*.sql, and vitest's 5s default already trips it
  // on a loaded runner. Bound it well above the growth curve, not just above
  // today's runtime.
  const MIGRATE_RACE_TIMEOUT_MS = 60_000;

  it(
    'serializes parallel migrators on a fresh database with no DDL race',
    async () => {
      const conn = targetUrl.toString();
      // Promise.all rejects if any migrator throws the create-type duplicate-key,
      // so resolving at all proves the lock held; the count assertions below
      // prove each migration ran exactly once across the eight racers.
      const results = await Promise.all(
        Array.from({ length: 8 }, () => migrate({ connectionString: conn, log: () => undefined })),
      );

      // Every call observes the same total migration set.
      const totals = results.map((r) => r.applied.length + r.skipped.length);
      expect(new Set(totals).size).toBe(1);
      const total = totals[0] ?? 0;
      expect(total).toBeGreaterThan(0);

      // Each migration is applied exactly once across all callers; the rest skip.
      const appliedTotal = results.reduce((sum, r) => sum + r.applied.length, 0);
      expect(appliedTotal).toBe(total);
    },
    MIGRATE_RACE_TIMEOUT_MS,
  );
});
