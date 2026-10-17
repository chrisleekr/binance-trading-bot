// Migration 0100 adds `profiles.baseline_pinned_at`, where the live-vs-backtest window starts. The claim worth testing is the one a fresh database cannot show: a profile that already existed, with a baseline already pinned, comes out of the migration with NULL, which every reader treats as the all-time window it used before. So the migrations are STAGED: everything below 0100 is applied, the row is seeded under the old schema, and only then is 0100 copied in and applied.

import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, Pool } from 'pg';
import { migrate } from '../src/migrate.js';
import { HAS_INFRA, sharedDatabaseUrl } from './_infra.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');
const TARGET_PREFIX = 100;
const prefixOf = (name: string): number => Number.parseInt(name.slice(0, 4), 10);

describe.skipIf(!HAS_INFRA)('profile baseline pin-time migration', () => {
  const dbName = `baseline_pin_${randomUUID().replaceAll('-', '')}_test`;
  const userId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  const runId = randomUUID();
  let adminUrl: URL;
  let stageDir: string;
  let targetUrl: string;
  let pool: Pool;

  const withAdmin = async (sql: string): Promise<void> => {
    const client = new Client({ connectionString: adminUrl.toString() });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  };

  const migrationNames = (): string[] =>
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();

  beforeAll(async () => {
    stageDir = mkdtempSync(join(HERE, '.tmp-baseline-pin-mig-'));
    const baseUrl = await sharedDatabaseUrl();
    adminUrl = new URL(baseUrl);
    adminUrl.pathname = '/postgres';
    const target = new URL(baseUrl);
    target.pathname = `/${dbName}`;
    targetUrl = target.toString();
    await withAdmin(`create database "${dbName}"`);

    for (const name of migrationNames().filter((n) => prefixOf(n) < TARGET_PREFIX)) {
      copyFileSync(join(MIGRATIONS_DIR, name), join(stageDir, name));
    }
    await migrate({ connectionString: targetUrl, migrationsDir: stageDir, log: () => undefined });
    pool = new Pool({ connectionString: targetUrl });
    await pool.query('insert into users (id, email) values ($1, $2)', [
      userId,
      `baseline-pin-${userId}@test.local`,
    ]);
    await pool.query(
      "insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'account', 'live')",
      [accountId, userId],
    );
    await pool.query(
      "insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state) values ($1, $2, 'profile', 'momentum', '1.0.0', '{}', '{}')",
      [profileId, accountId],
    );
    await pool.query(
      "insert into backtest_runs (id, profile_id, symbols, params, status) values ($1, $2, '{BTCUSDT}', '{}', 'done')",
      [runId, profileId],
    );
    await pool.query('update profiles set baseline_backtest_run_id = $1 where id = $2', [
      runId,
      profileId,
    ]);

    const name = migrationNames().find((n) => prefixOf(n) === TARGET_PREFIX);
    if (!name) throw new Error(`migration ${TARGET_PREFIX} not found`);
    copyFileSync(join(MIGRATIONS_DIR, name), join(stageDir, name));
    await migrate({ connectionString: targetUrl, migrationsDir: stageDir, log: () => undefined });
  });

  afterAll(async () => {
    await pool?.end();
    if (adminUrl) await withAdmin(`drop database if exists "${dbName}" with (force)`);
    if (stageDir) rmSync(stageDir, { recursive: true, force: true });
  });

  it('leaves an existing pin in place with no pin time, so it keeps the all-time window', async () => {
    const { rows } = await pool.query<{ run: string | null; at: Date | null }>(
      'select baseline_backtest_run_id as run, baseline_pinned_at as at from profiles where id = $1',
      [profileId],
    );
    expect(rows[0]).toEqual({ run: runId, at: null });
  });

  it('adds a nullable timestamptz column', async () => {
    const { rows } = await pool.query<{ data_type: string; is_nullable: string }>(
      "select data_type, is_nullable from information_schema.columns where table_name = 'profiles' and column_name = 'baseline_pinned_at'",
    );
    expect(rows[0]).toEqual({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
  });
});
