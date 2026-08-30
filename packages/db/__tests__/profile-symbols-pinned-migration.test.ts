import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/migrate.js';

// Data-correctness test for migration 0088: splitting reap-protection out of `profile_symbols.source`.
//
// The interesting case is a row in the PRE-SPLIT shape (`source='manual'` with `pinned` left at the column default) run through 0088's statements — which is what a deployed database looks like at the moment the migration runs, and the only way to see the backfill actually move a row. The harness has already applied every migration, so such a row has to be inserted afterwards and the file re-applied.
//
// The two halves under test are the two ways this migration can be wrong: a backfill that misses a row silently starts rotating out the operator's own coins, and a post-flight that cannot see such a row lets that ship.
//
// It runs against a SCRATCH DATABASE of its own rather than the shared test database. 0088's post-flight is global by nature — it asks whether ANY unpinned operator row survives — and the sibling suites run in parallel and legitimately create exactly that shape, so a shared database would make both the backfill assertions and the deliberate abort race unrelated files.
//
// Needs a live Postgres (DATABASE_TEST_URL); skipped in the unit stage, exercised in the integration stage.

const TEST_DB_URL = process.env['DATABASE_TEST_URL'];
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  resolve(HERE, '..', 'migrations', '0088_profile_symbols_pinned.sql'),
  'utf8',
);

// Postgres identifiers cannot start with a digit and cap at 63 bytes; the `_test` suffix keeps the scratch database inside the same naming guard the isolation fixtures assert on.
const SCRATCH_DB = `mig0088_${randomUUID().replaceAll('-', '')}_test`;

describe.skipIf(!TEST_DB_URL)('migration 0088 — pin split out of provenance', () => {
  let adminPool: Pool;
  let pool: Pool;
  const userId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();

  beforeAll(async () => {
    if (!TEST_DB_URL) return; // describe.skipIf guards execution; this narrows the type
    adminPool = new Pool({ connectionString: TEST_DB_URL });
    // Identifier interpolation, because CREATE DATABASE takes no bind parameters; the name is a locally-minted UUID, never input.
    await adminPool.query(`create database "${SCRATCH_DB}"`);
    const scratchUrl = new URL(TEST_DB_URL);
    scratchUrl.pathname = `/${SCRATCH_DB}`;
    await migrate({ connectionString: scratchUrl.toString(), log: () => undefined });
    pool = new Pool({ connectionString: scratchUrl.toString() });
    await pool.query(`insert into users (id, email) values ($1, $2)`, [
      userId,
      `pinsplit-${userId}@test.local`,
    ]);
    await pool.query(
      `insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'demo', 'test')`,
      [accountId, userId],
    );
    await pool.query(
      `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
       values ($1, $2, 'p-pinsplit', 'trailing-trade', '2.0.0', '{}'::jsonb, '{}'::jsonb)`,
      [profileId, accountId],
    );
  });

  afterAll(async () => {
    await pool?.end();
    // The scratch database exists only for this file; dropping it also removes the deliberately-broken row the abort test leaves behind.
    await adminPool?.query(`drop database if exists "${SCRATCH_DB}"`);
    await adminPool?.end();
  });

  // The pre-split shape: provenance set, `pinned` left at the column default.
  const seedBinding = async (symbol: string, source: string): Promise<void> => {
    await pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source)
       values ($1, $2, $3, $4)`,
      [profileId, symbol, symbol.replace('USDT', ''), source],
    );
  };

  const pinOf = async (symbol: string): Promise<{ pinned: boolean; pinnedAt: Date | null }> => {
    const res = await pool.query<{ pinned: boolean; pinned_at: Date | null }>(
      `select pinned, pinned_at from profile_symbols where profile_id = $1 and symbol = $2`,
      [profileId, symbol],
    );
    const row = res.rows[0];
    if (!row) throw new Error(`binding ${symbol} not found`);
    return { pinned: row.pinned, pinnedAt: row.pinned_at };
  };

  it('pins every operator-added row and leaves its stamp NULL', async () => {
    await seedBinding('MIGAUSDT', 'manual');
    await pool.query(MIGRATION_SQL);

    // Under the old model `source='manual'` WAS the reap exemption, so dropping it without moving the row would hand the operator's own coins to the rotation.
    const { pinned, pinnedAt } = await pinOf('MIGAUSDT');
    expect(pinned).toBe(true);
    // No honest timestamp exists for an inferred pin. NULL is what the UI reads as "nobody is recorded as having chosen this", so fabricating `now()` here would make every legacy row indistinguishable from a deliberate pin.
    expect(pinnedAt).toBeNull();
  });

  it('leaves discovery-rotated rows unpinned so they keep rotating', async () => {
    await seedBinding('MIGBUSDT', 'auto');
    await pool.query(MIGRATION_SQL);
    expect(await pinOf('MIGBUSDT')).toEqual({ pinned: false, pinnedAt: null });
  });

  it('is idempotent: a re-run neither unpins a row nor re-stamps it', async () => {
    await seedBinding('MIGCUSDT', 'manual');
    await pool.query(MIGRATION_SQL);
    await pool.query(
      `update profile_symbols set pinned_at = $3 where profile_id = $1 and symbol = $2`,
      [profileId, 'MIGCUSDT', new Date('2026-08-24T00:00:00.000Z')],
    );
    await pool.query(MIGRATION_SQL);
    const { pinned, pinnedAt } = await pinOf('MIGCUSDT');
    expect(pinned).toBe(true);
    // A deliberate pin recorded after the rollout must survive a re-apply, or the second run would erase the very evidence the first one could not produce.
    expect(pinnedAt?.toISOString()).toBe('2026-08-24T00:00:00.000Z');
  });

  it('admits the widened provenance vocabulary on both tables', async () => {
    await pool.query(MIGRATION_SQL);
    // `unknown` is what every system-recovery path now writes; a check constraint that still refused it would take the whole fill adoption down with it.
    await expect(seedBinding('MIGDUSDT', 'unknown')).resolves.toBeUndefined();
    await expect(
      pool.query(
        `insert into trade_archive (profile_id, symbol, base_asset, quote_asset, source, total_buy_quote, total_sell_quote, profit)
         values ($1, 'MIGEUSDT', 'MIGE', 'USDT', 'unknown', 0, 0, 0)`,
        [profileId],
      ),
    ).resolves.toBeDefined();
  });

  it('the post-flight ABORTS when the backfill misses a row', async () => {
    // Fault injection against the BACKFILL, not against the row: re-opening the hole by hand proves nothing, because the migration's own update closes it again on the way to the post-flight. The failure this guard exists to catch is a backfill that does not reach every row, so the injected fault has to be the missing update.
    const withoutBackfill = MIGRATION_SQL.replace(
      "update profile_symbols set pinned = true where source = 'manual';",
      '',
    );
    // The replacement has to have bitten, or the "abort" below would just be the intact migration succeeding and the assertion would be dead.
    expect(withoutBackfill).not.toBe(MIGRATION_SQL);

    await seedBinding('MIGFUSDT', 'manual');
    await expect(pool.query(withoutBackfill)).rejects.toThrow(/pin backfill incomplete/);

    // And the real file, backfill included, sails through the same row.
    await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
    expect((await pinOf('MIGFUSDT')).pinned).toBe(true);
  });
});
