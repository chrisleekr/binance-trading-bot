import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrate } from '../src/migrate.js';

// Migration-safety test for issue #503 (remove per-profile paper trading).
// Migration 0074 must (1) drop the demo_mode column and the simulated_orders
// table, and (2) NEVER silently promote a demo profile to live: a profile that
// was demo_mode=true must land enabled=false. To prove the demo→disabled
// transform we need a demo_mode=true row present when 0074 runs, but the column
// is gone afterward and cannot be inserted into. So the harness applies every
// migration BEFORE 0074 into a throwaway database, seeds a demo_mode=true /
// enabled=true profile, then applies the remaining migration(s) and asserts.
//
// Needs a real Postgres: TESTCONTAINERS=1 boots a throwaway container, or
// DATABASE_TEST_URL names a pre-existing server (a throwaway database is created
// on it so the partial-migration sequence starts from an empty schema). Skipped
// in the no-Docker unit lane.

const HAS_INFRA =
  process.env['TESTCONTAINERS'] === '1' || Boolean(process.env['DATABASE_TEST_URL']);

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');

// 0074 is the migration under test: it drops demo_mode + simulated_orders.
const TARGET_MIGRATION_PREFIX = 74;
const prefixOf = (name: string): number => Number.parseInt(name.slice(0, 4), 10);

const migrationNames = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

describe.skipIf(!HAS_INFRA)('migration 0074 — remove paper trading', () => {
  const dbName = `bt_rm_paper_${randomUUID().replace(/-/g, '')}`;
  let stopContainer: () => Promise<void> = async () => undefined;
  let adminUrl: URL;
  let targetUrl: string;
  let pool: Pool;

  const userId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();

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
    let baseUrl: string;
    if (process.env['TESTCONTAINERS'] === '1') {
      const { withPostgres } = await import('@app/testcontainers');
      const pg = await withPostgres();
      baseUrl = pg.databaseUrl;
      stopContainer = pg.stop;
    } else {
      baseUrl = process.env['DATABASE_TEST_URL'] as string;
    }
    adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const target = new URL(baseUrl);
    target.pathname = `/${dbName}`;
    targetUrl = target.toString();

    await withAdmin(`create database "${dbName}"`);

    // Stage 1: apply everything BEFORE 0074, so the demo_mode column and
    // simulated_orders table still exist to seed against.
    const stageDir = mkdtempSync(join(tmpdir(), 'rm-paper-mig-'));
    const all = migrationNames();
    for (const name of all.filter((n) => prefixOf(n) < TARGET_MIGRATION_PREFIX)) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(stageDir, name));
    }
    await migrate({ connectionString: targetUrl, migrationsDir: stageDir, log: () => undefined });

    pool = new Pool({ connectionString: targetUrl });
    await pool.query(`insert into users (id, email) values ($1, $2)`, [
      userId,
      `rm-paper-${userId}@test.local`,
    ]);
    await pool.query(
      `insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'demo', 'test')`,
      [accountId, userId],
    );
    // A demo profile that was actively enabled — the exact row 0074 must NOT
    // promote to live.
    await pool.query(
      `insert into profiles
         (id, account_id, name, strategy_name, strategy_version, config, state, demo_mode, enabled)
       values ($1, $2, 'demo-profile', 'trailing-trade', '2.0.0', '{}', '{}', true, true)`,
      [profileId, accountId],
    );

    // Stage 2: apply the remaining migration(s), 0074 onward.
    for (const name of all.filter((n) => prefixOf(n) >= TARGET_MIGRATION_PREFIX)) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(stageDir, name));
    }
    await migrate({ connectionString: targetUrl, migrationsDir: stageDir, log: () => undefined });
  }, 180_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminUrl) await withAdmin(`drop database if exists "${dbName}" with (force)`);
    await stopContainer();
  });

  it('drops the profiles.demo_mode column', async () => {
    const res = await pool.query(
      `select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles' and column_name = 'demo_mode'`,
    );
    expect(res.rowCount).toBe(0);
  });

  it('drops the simulated_orders table', async () => {
    const res = await pool.query<{ reg: string | null }>(
      `select to_regclass('public.simulated_orders') as reg`,
    );
    expect(res.rows[0]?.reg).toBeNull();
  });

  it('disables a profile that was demo_mode=true (never promoted to live)', async () => {
    const res = await pool.query<{ enabled: boolean }>(
      `select enabled from profiles where id = $1`,
      [profileId],
    );
    expect(res.rows[0]?.enabled).toBe(false);
  });
});
