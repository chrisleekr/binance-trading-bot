import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/migrate.js';

// Data-correctness test for migration 0030: the unified-regime config rewrite.
// The harness applies every migration at setup, so a freshly-inserted row keeps
// its old-shape keys; we then run the 0030 UPDATE statements against it and
// assert the transform. Needs a live Postgres (DATABASE_TEST_URL); skipped in
// the unit stage, exercised in the integration stage.

const TEST_DB_URL = process.env['DATABASE_TEST_URL'];
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  resolve(HERE, '..', 'migrations', '0030_regime_unified_config.sql'),
  'utf8',
);

describe.skipIf(!TEST_DB_URL)('migration 0030 — unified regime config', () => {
  let pool: Pool;
  const userId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  const overrideProfileId = randomUUID();

  beforeAll(async () => {
    if (!TEST_DB_URL) return; // describe.skipIf guards execution; this narrows the type
    await migrate({ connectionString: TEST_DB_URL, log: () => undefined });
    pool = new Pool({ connectionString: TEST_DB_URL });
    await pool.query(`insert into users (id, email) values ($1, $2)`, [
      userId,
      `regime-${userId}@test.local`,
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

  const seedProfile = async (id: string, config: unknown) => {
    await pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, $3, 'trailing-trade', '2.0.0', $4, '{}')`,
      [id, accountId, `p-${id.slice(0, 8)}`, JSON.stringify(config)],
    );
  };
  const configOf = async (id: string): Promise<Record<string, unknown>> => {
    const res = await pool.query<{ config: Record<string, unknown> }>(
      `select config from profiles where id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`profile ${id} not found`);
    return row.config;
  };

  it('rewrites a base profile config: old keys gone, full regime block present', async () => {
    await seedProfile(profileId, {
      buy: { enabled: true, regimeFilter: { enabled: true, ma: 'ema', period: 50 } },
      sell: {
        enabled: true,
        regimeExit: { enabled: true, ma: 'sma', period: 200, confirmBars: 3 },
      },
    });

    await pool.query(MIGRATION_SQL);

    const config = await configOf(profileId);
    // regimeExit's MA wins on conflict (richer, confirmBars-bearing).
    expect(config['regime']).toEqual({
      ma: 'sma',
      period: 200,
      confirmBars: 3,
      onBear: { exitToCash: true, suppressPromotion: true },
    });
    expect((config['buy'] as Record<string, unknown>)['regimeFilter']).toBeUndefined();
    expect((config['sell'] as Record<string, unknown>)['regimeExit']).toBeUndefined();
  });

  it('leaves a config without the old keys untouched (no regime block injected)', async () => {
    const cleanId = randomUUID();
    await seedProfile(cleanId, { buy: { enabled: true }, sell: { enabled: true } });
    await pool.query(MIGRATION_SQL);
    expect((await configOf(cleanId))['regime']).toBeUndefined();
  });

  it('migrates a partial override to a minimal regime patch (only the set key)', async () => {
    await seedProfile(overrideProfileId, { buy: { enabled: true }, sell: { enabled: true } });
    await pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, override_config)
       values ($1, 'ETHUSDT', 'ETH', $2)`,
      [
        overrideProfileId,
        JSON.stringify({ buy: { regimeFilter: { enabled: true, ma: 'ema', period: 20 } } }),
      ],
    );

    await pool.query(MIGRATION_SQL);

    const row = await pool.query<{ override_config: Record<string, unknown> }>(
      `select override_config from profile_symbols where profile_id = $1 and symbol = 'ETHUSDT'`,
      [overrideProfileId],
    );
    const overrideRow = row.rows[0];
    if (!overrideRow) throw new Error('override row not found');
    const override = overrideRow.override_config;
    // Only the suppressPromotion toggle + the filter's ma/period are carried —
    // no exitToCash/confirmBars defaults that would clobber the base on merge.
    expect(override['regime']).toEqual({
      ma: 'ema',
      period: 20,
      onBear: { suppressPromotion: true },
    });
    expect((override['buy'] as Record<string, unknown>)['regimeFilter']).toBeUndefined();
  });
});
