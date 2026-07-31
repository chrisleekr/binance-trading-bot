import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/migrate.js';

// Data-correctness test for migration 0063: rewrite a stale enablement_policy
// monitor.mode left behind when the enum was narrowed to ('off','warn'). The
// harness applies every migration at setup, so we insert a legacy-shape row and
// re-run the 0063 UPDATE against it. Needs a live Postgres (DATABASE_TEST_URL);
// skipped in the unit stage, exercised in the integration stage.

const TEST_DB_URL = process.env['DATABASE_TEST_URL'];
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  resolve(HERE, '..', 'migrations', '0063_fix_legacy_monitor_mode.sql'),
  'utf8',
);

describe.skipIf(!TEST_DB_URL)('migration 0063 — legacy monitor.mode', () => {
  let pool: Pool;
  const userId = randomUUID();
  const accountId = randomUUID();

  beforeAll(async () => {
    if (!TEST_DB_URL) return; // describe.skipIf guards execution; this narrows the type
    await migrate({ connectionString: TEST_DB_URL, log: () => undefined });
    pool = new Pool({ connectionString: TEST_DB_URL });
    await pool.query(`insert into users (id, email) values ($1, $2)`, [
      userId,
      `monitor-${userId}@test.local`,
    ]);
    // profiles hang off an account now; binance_mode lives on the account.
    await pool.query(
      `insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'demo', 'test')`,
      [accountId, userId],
    );
  });

  afterAll(async () => {
    await pool.query(`delete from users where id = $1`, [userId]);
    await pool.end();
  });

  const seedProfile = async (id: string, enablementPolicy: unknown) => {
    await pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state, enablement_policy)
       values ($1, $2, $3, 'trailing-trade', '2.0.0', '{}', '{}', $4)`,
      [
        id,
        accountId,
        `p-${id.slice(0, 8)}`,
        enablementPolicy === null ? null : JSON.stringify(enablementPolicy),
      ],
    );
  };
  const modeOf = async (id: string): Promise<string | null> => {
    const res = await pool.query<{ mode: string | null }>(
      `select enablement_policy #>> '{monitor,mode}' as mode from profiles where id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`profile ${id} not found`);
    return row.mode;
  };
  const policyOf = async (id: string): Promise<Record<string, unknown>> => {
    const res = await pool.query<{ enablement_policy: Record<string, unknown> }>(
      `select enablement_policy from profiles where id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`profile ${id} not found`);
    return row.enablement_policy;
  };

  it('rewrites monitor.mode halt→warn, leaves siblings untouched, and is idempotent', async () => {
    const id = randomUUID();
    // Non-default siblings so this proves jsonb_set touches only monitor.mode.
    await seedProfile(id, {
      enabled: true,
      minProfitFactor: 1.5,
      monitor: { mode: 'halt', minTrades: 25, warnFactor: 0.7, breachFactor: 0.5 },
    });

    await pool.query(MIGRATION_SQL);

    expect(await modeOf(id)).toBe('warn');
    const pol = await policyOf(id);
    expect(pol['minProfitFactor']).toBe(1.5);
    expect((pol['monitor'] as Record<string, unknown>)['warnFactor']).toBe(0.7);
    expect((pol['monitor'] as Record<string, unknown>)['breachFactor']).toBe(0.5);

    // Second run is a no-op (the WHERE clause no longer matches the now-warn row).
    await pool.query(MIGRATION_SQL);
    expect(await modeOf(id)).toBe('warn');
  });

  it('leaves a valid monitor.mode untouched', async () => {
    const id = randomUUID();
    await seedProfile(id, { enabled: true, monitor: { mode: 'off' } });
    await pool.query(MIGRATION_SQL);
    expect(await modeOf(id)).toBe('off');
  });

  it('leaves a null enablement_policy untouched', async () => {
    const id = randomUUID();
    await seedProfile(id, null);
    await pool.query(MIGRATION_SQL);
    expect(await modeOf(id)).toBeNull();
  });
});
