import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * The one-time repair of state already stranded by past unbinds.
 *
 * `setupFixture` migrates before it seeds, so booting the fixture proves only
 * that the file APPLIES — it says nothing about what the statements delete.
 * These cases therefore read the migration body off disk and run it against
 * deliberately stranded rows.
 *
 * Every case runs inside a transaction that is rolled back. The migration's
 * predicates are table-wide, so a committed run here would delete rows other
 * isolation suites seeded for their own assertions; under MVCC an uncommitted
 * delete is invisible to them and the rollback restores it.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const MIGRATION = '0083_orphan_per_symbol_state_cleanup.sql';

const readMigration = (): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = resolve(here, '..', '..', 'migrations', MIGRATION);
  if (!existsSync(path)) {
    throw new Error(
      `migrations/${MIGRATION} does not exist: the orphan per-symbol-state cleanup has not been authored`,
    );
  }
  return readFileSync(path, 'utf8');
};

/** Rows for one (profile, symbol) on each per-symbol surface. */
interface SurfaceCounts {
  conditions: number;
  states: number;
  avgEntry: number;
  pendingOverrides: number;
}

const BOUND = 'OCBUSDT';
/** Never written to `profile_symbols`, so every row seeded for it is stranded. */
const ORPHAN = 'OCOUSDT';
/** A stranded ledger row still claiming a position. */
const ORPHAN_HELD = 'OCHUSDT';

describeIfDb('orphan per-symbol state cleanup migration', () => {
  let fx: IsolationFixture;
  let sql: string;

  beforeAll(async () => {
    fx = await setupFixture();
    sql = readMigration();
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  /** `count(*)` as a number. Counted as text so a bigint never rides through a float. */
  const scalar = async (client: PoolClient, query: string, symbol: string): Promise<number> => {
    const res = await client.query<{ n: string }>(query, [fx.alice.profileId, symbol]);
    return Number(res.rows[0]?.n ?? '0');
  };

  const count = (client: PoolClient, table: string, symbol: string): Promise<number> =>
    scalar(
      client,
      `select count(*)::text as n from ${table} where profile_id = $1 and symbol = $2`,
      symbol,
    );

  const countPendingOverrides = (client: PoolClient, symbol: string): Promise<number> =>
    scalar(
      client,
      `select count(*)::text as n from override_actions
         where profile_id = $1 and symbol = $2
           and consumed_at is null and processing_at is null`,
      symbol,
    );

  const countSettledOverrides = (client: PoolClient, symbol: string): Promise<number> =>
    scalar(
      client,
      `select count(*)::text as n from override_actions
         where profile_id = $1 and symbol = $2 and consumed_at is not null`,
      symbol,
    );

  const surfaces = async (client: PoolClient, symbol: string): Promise<SurfaceCounts> => ({
    conditions: await count(client, 'condition_states', symbol),
    states: await count(client, 'symbol_states', symbol),
    avgEntry: await count(client, 'avg_entry_prices', symbol),
    pendingOverrides: await countPendingOverrides(client, symbol),
  });

  const seed = async (client: PoolClient): Promise<void> => {
    const p = fx.alice.profileId;
    await client.query(
      `insert into profile_symbols (profile_id, symbol, base_asset) values ($1, $2, 'OCB')`,
      [p, BOUND],
    );
    for (const symbol of [BOUND, ORPHAN]) {
      await client.query(
        `insert into condition_states (profile_id, condition, symbol, code)
           values ($1, 'entry-blocked', $2, 'knife-guard')`,
        [p, symbol],
      );
      await client.query(
        `insert into symbol_states (profile_id, symbol, state, strategy_version)
           values ($1, $2, '{"schemaVersion":"1.0.0"}'::jsonb, '1.0.0')`,
        [p, symbol],
      );
      await client.query(
        `insert into avg_entry_prices (profile_id, symbol, avg_entry_price, quantity)
           values ($1, $2, 100, 0)`,
        [p, symbol],
      );
      await client.query(
        `insert into override_actions (profile_id, symbol, action, action_at, payload, triggered_by)
           values ($1, $2, 'buy', now(), '{}'::jsonb, 'test')`,
        [p, symbol],
      );
    }
    // The profile itself is the subject, stored as the empty-string sentinel;
    // it has no binding to resolve against and must never be swept.
    await client.query(
      `insert into condition_states (profile_id, condition, symbol, code)
         values ($1, 'discovery-idle', '', 'no-candidates')`,
      [p],
    );
    // A stranded ledger row claiming a position: destroying it would erase the
    // cost basis of coins the operator still holds. Its state body is the only
    // thing that prices that claim, so the two must survive or die together.
    await client.query(
      `insert into avg_entry_prices (profile_id, symbol, avg_entry_price, quantity)
         values ($1, $2, 100, 0.5)`,
      [p, ORPHAN_HELD],
    );
    await client.query(
      `insert into symbol_states (profile_id, symbol, state, strategy_version)
         values ($1, $2, '{"schemaVersion":"1.0.0"}'::jsonb, '1.0.0')`,
      [p, ORPHAN_HELD],
    );
    // A settled override is history the dust-transfer view reads, not queued
    // work, so the sweep leaves it even though its symbol is unbound.
    await client.query(
      `insert into override_actions (profile_id, symbol, action, action_at, payload, triggered_by, consumed_at)
         values ($1, $2, 'dust-transfer', now(), '{}'::jsonb, 'test', now())`,
      [p, ORPHAN],
    );
  };

  /** Seeds, runs the migration `runs` times, asserts, then rolls everything back. */
  const withCleanup = async (
    runs: number,
    assertions: (client: PoolClient) => Promise<void>,
  ): Promise<void> => {
    const client = await fx.pool.connect();
    try {
      await client.query('begin');
      // The migration's predicates are table-wide, so this transaction takes row
      // locks on rows sibling suites committed, and files run in parallel against
      // one database. Bound the wait so contention surfaces as a fast, named
      // error rather than a suite that hangs to the timeout.
      await client.query("set local lock_timeout = '5s'");
      await seed(client);
      for (let i = 0; i < runs; i += 1) await client.query(sql);
      await assertions(client);
    } finally {
      await client.query('rollback');
      client.release();
    }
  };

  it('deletes every per-symbol row whose symbol is no longer bound', async () => {
    await withCleanup(1, async (client) => {
      expect(await surfaces(client, ORPHAN)).toEqual({
        conditions: 0,
        states: 0,
        avgEntry: 0,
        pendingOverrides: 0,
      });
    });
  });

  it('leaves the bound symbol untouched', async () => {
    await withCleanup(1, async (client) => {
      expect(await surfaces(client, BOUND)).toEqual({
        conditions: 1,
        states: 1,
        avgEntry: 1,
        pendingOverrides: 1,
      });
    });
  });

  it('leaves the profile-level condition in place', async () => {
    await withCleanup(1, async (client) => {
      expect(await count(client, 'condition_states', '')).toBe(1);
    });
  });

  it('leaves a stranded ledger row that still claims a position', async () => {
    await withCleanup(1, async (client) => {
      expect(await count(client, 'avg_entry_prices', ORPHAN_HELD)).toBe(1);
    });
  });

  // Sweeping the body while sparing the ledger row leaves a position no state
  // prices, and `dispose_profile` audits EVERY ledger row before handing off —
  // so the profile could never be disposed again.
  it('leaves the state body of a stranded ledger row that still claims a position', async () => {
    await withCleanup(1, async (client) => {
      expect(await count(client, 'symbol_states', ORPHAN_HELD)).toBe(1);
    });
  });

  it('leaves a settled override even when its symbol is unbound', async () => {
    await withCleanup(1, async (client) => {
      expect(await countSettledOverrides(client, ORPHAN)).toBe(1);
    });
  });

  it('is idempotent: a second run changes nothing', async () => {
    await withCleanup(2, async (client) => {
      expect(await surfaces(client, ORPHAN)).toEqual({
        conditions: 0,
        states: 0,
        avgEntry: 0,
        pendingOverrides: 0,
      });
      expect(await surfaces(client, BOUND)).toEqual({
        conditions: 1,
        states: 1,
        avgEntry: 1,
        pendingOverrides: 1,
      });
      expect(await count(client, 'condition_states', '')).toBe(1);
      expect(await count(client, 'avg_entry_prices', ORPHAN_HELD)).toBe(1);
      expect(await count(client, 'symbol_states', ORPHAN_HELD)).toBe(1);
    });
  });
});
