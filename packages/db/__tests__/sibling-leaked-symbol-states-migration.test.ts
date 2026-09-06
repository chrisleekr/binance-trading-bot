import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { migrate } from '../src/migrate.js';
import { HAS_INFRA, sharedDatabaseUrl } from './_infra.js';

// Data-correctness test for migration 0094: purging the per-symbol state and the open condition rows a sibling profile wrote for symbols it was never bound to.
//
// The decision surface for the `symbol_states` half is what "holds no position" is allowed to mean. A BOUND row survives whatever its body says — the profile trades that symbol. An UNBOUND row that holds nothing is the leak, and is the only row this may delete. An UNBOUND row that still holds coins must survive, by either surface that can claim a position: the `avg_entry_prices` ledger row, or the state body's own `heldQuantity`. The `condition_states` half has the simpler rule and the sentinel exemption.
//
// A SECOND profile on the same account carries the fixtures for the `profile_id` halves of both `NOT EXISTS` subqueries. Without it every row belongs to one profile, both correlations are no-ops, and a sibling's binding or ledger row would shield this profile's leaked row with every test still green.
//
// The harness applies every migration before the test runs, so the rows are seeded afterwards and the file is re-applied by hand. That also proves the statements are idempotent by construction: they run a second time here against a database that already ran them once.
//
// Needs a real Postgres — `TESTCONTAINERS=1` or `DATABASE_TEST_URL`; skipped in the no-Docker unit lane.

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  resolve(HERE, '..', 'migrations', '0094_purge_sibling_leaked_symbol_states.sql'),
  'utf8',
);

// Postgres identifiers cannot start with a digit and cap at 63 bytes; the `_test` suffix keeps the scratch database inside the same naming guard the isolation fixtures assert on.
const SCRATCH_DB = `mig0094_${randomUUID().replaceAll('-', '')}_test`;

describe.skipIf(!HAS_INFRA)('migration 0094 — purge sibling-leaked per-symbol state', () => {
  let adminPool: Pool;
  let pool: Pool;
  const userId = randomUUID();
  const accountId = randomUUID();
  const profileId = randomUUID();
  // The sibling that did the placing. Its bindings and ledger rows must never shield this profile's leaked rows.
  const siblingId = randomUUID();

  beforeAll(async () => {
    const baseUrl = await sharedDatabaseUrl();
    adminPool = new Pool({ connectionString: baseUrl });
    // Identifier interpolation, because CREATE DATABASE takes no bind parameters; the name is a locally-minted UUID, never input.
    await adminPool.query(`create database "${SCRATCH_DB}"`);
    const scratchUrl = new URL(baseUrl);
    scratchUrl.pathname = `/${SCRATCH_DB}`;
    await migrate({ connectionString: scratchUrl.toString(), log: () => undefined });
    pool = new Pool({ connectionString: scratchUrl.toString() });
    await pool.query(`insert into users (id, email) values ($1, $2)`, [
      userId,
      `leak-${userId}@test.local`,
    ]);
    await pool.query(
      `insert into accounts (id, owner_id, name, binance_mode) values ($1, $2, 'demo', 'test')`,
      [accountId, userId],
    );
    for (const [id, name] of [
      [profileId, 'p-leak'],
      [siblingId, 'p-sibling'],
    ]) {
      await pool.query(
        `insert into profiles (id, account_id, name, strategy_name, strategy_version, config, state)
         values ($1, $2, $3, 'trailing-trade', '2.0.0', '{}'::jsonb, '{}'::jsonb)`,
        [id, accountId, name],
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`drop database if exists "${SCRATCH_DB}"`);
    await adminPool?.end();
  });

  const seedState = async (
    symbol: string,
    heldQuantity: string | null,
    owner = profileId,
  ): Promise<void> => {
    await pool.query(
      `insert into symbol_states (profile_id, symbol, state, strategy_version)
       values ($1, $2, $3::jsonb, '2.0.0')`,
      [owner, symbol, JSON.stringify({ heldQuantity })],
    );
  };

  const bind = async (symbol: string, owner = profileId): Promise<void> => {
    await pool.query(
      `insert into profile_symbols (profile_id, symbol, base_asset, source)
       values ($1, $2, $3, 'manual')`,
      [owner, symbol, symbol.replace('USDT', '')],
    );
  };

  const seedLedger = async (symbol: string, quantity: string, owner = profileId): Promise<void> => {
    await pool.query(
      `insert into avg_entry_prices (profile_id, symbol, avg_entry_price, quantity)
       values ($1, $2, '100', $3)`,
      [owner, symbol, quantity],
    );
  };

  const ledgers = async (owner = profileId): Promise<string[]> => {
    const res = await pool.query<{ symbol: string }>(
      `select symbol from avg_entry_prices where profile_id = $1 order by symbol`,
      [owner],
    );
    return res.rows.map((r) => r.symbol);
  };

  const survivors = async (owner = profileId): Promise<string[]> => {
    const res = await pool.query<{ symbol: string }>(
      `select symbol from symbol_states where profile_id = $1 order by symbol`,
      [owner],
    );
    return res.rows.map((r) => r.symbol);
  };

  it('deletes the unbound, position-free rows and keeps every other shape', async () => {
    await seedState('BOUNDUSDT', '0');
    await bind('BOUNDUSDT');
    await seedState('LEAKEDUSDT', '0');
    // The shape the live damage actually has: `TTStateSchema` defaults `heldQuantity` to null, and a state seeded by a tick for a symbol the profile never owned never moves it off that.
    await seedState('LEAKEDNULLUSDT', null);
    await seedState('HELDUSDT', '0.75');

    await pool.query(MIGRATION_SQL);

    // `arrayContaining` plus explicit absences, not an exact `toEqual`: sibling cases below add rows to this same profile, and an exact match would pass only while Vitest happens to run in declaration order.
    const rows = await survivors();
    expect(rows).toEqual(expect.arrayContaining(['BOUNDUSDT', 'HELDUSDT']));
    expect(rows).not.toContain('LEAKEDUSDT');
    expect(rows).not.toContain('LEAKEDNULLUSDT');
  });

  // A null `heldQuantity` is the schema's explicit "flat", not a value the predicate failed to read, so it is deleted like any other flat row — and `->>` answers SQL NULL for an absent key too. Both are pinned because `NULL ~ '…'` is NULL rather than true: a predicate resting on the regex alone silently KEEPS every row of the shape this migration exists to purge, which is strictly weaker than 0083, whose statement carried no `heldQuantity` condition at all.
  it.each([
    ['an explicit json null', 'NULLQTYUSDT', '{"heldQuantity": null}'],
    ['no heldQuantity key at all', 'ABSENTQTYUSDT', '{"schemaVersion": 2}'],
  ])('deletes an unbound row whose state carries %s', async (_label, symbol, body) => {
    await pool.query(
      `insert into symbol_states (profile_id, symbol, state, strategy_version)
       values ($1, $2, $3::jsonb, '2.0.0')`,
      [profileId, symbol, body],
    );

    await pool.query(MIGRATION_SQL);

    expect(await survivors()).not.toContain(symbol);
  });

  it('keeps an unbound row whose only claim to a position is its avg_entry_prices ledger row', async () => {
    await seedState('LEDGERUSDT', '0');
    await seedLedger('LEDGERUSDT', '2.5');

    await pool.query(MIGRATION_SQL);

    expect(await survivors()).toContain('LEDGERUSDT');
  });

  // The ledger guard is `quantity > 0`, not "a row exists". A closed position leaves the row behind at zero, and that is not a claim on anything — treating it as one would make every symbol the profile ever traded permanently unsweepable.
  //
  // BOTH halves are asserted. Deleting the state row and leaving the zero-quantity ledger row is the orphan pair the pairing rule forbids, and `assertTargetSeeded` reads every ledger row with no quantity filter — so that pair wedges a later handoff disposal into this profile forever. An assertion on `survivors()` alone passes with the ledger statement missing entirely.
  it('deletes an unbound row and its closed-out ledger row together', async () => {
    await seedState('CLOSEDUSDT', '0');
    await seedLedger('CLOSEDUSDT', '0');

    await pool.query(MIGRATION_SQL);

    expect(await survivors()).not.toContain('CLOSEDUSDT');
    expect(await ledgers()).not.toContain('CLOSEDUSDT');
  });

  it("keeps an unbound profile's ledger row while it still claims a position", async () => {
    await seedState('KEEPLEDGERUSDT', '0');
    await seedLedger('KEEPLEDGERUSDT', '1.25');

    await pool.query(MIGRATION_SQL);

    expect(await ledgers()).toContain('KEEPLEDGERUSDT');
  });

  // The reason the predicate is a regex and not a `::numeric` cast: a cast is partial, and any one of these bodies would abort the transaction and wedge the whole deploy. The reason it matches the FLAT form instead of excluding the held one: every body here fails the match, so every one of these rows survives — an inverse spelling like `!~ '[1-9]'` would delete the first two, which are exactly the rows nothing can read well enough to judge.
  it.each([['not-a-number'], ['NaN'], ['1e-8']])(
    'keeps an unbound row whose heldQuantity reads as %s rather than aborting the migration',
    async (held) => {
      const symbol = `ODD${held.replaceAll(/[^A-Z0-9]/gi, '')}USDT`;
      await seedState(symbol, held);

      await expect(pool.query(MIGRATION_SQL)).resolves.toBeDefined();
      expect(await survivors()).toContain(symbol);
    },
  );

  it('deletes an unbound row whose heldQuantity is zero however it is spelled', async () => {
    await seedState('ZEROAUSDT', '0.00000000');
    await seedState('ZEROBUSDT', '0');

    await pool.query(MIGRATION_SQL);

    const rows = await survivors();
    expect(rows).not.toContain('ZEROAUSDT');
    expect(rows).not.toContain('ZEROBUSDT');
  });

  // Both `NOT EXISTS` clauses correlate on `profile_id`. Drop either correlation and the sibling's row below answers for this profile, shielding exactly the leaked row the migration exists to delete — and no single-profile fixture can see it.
  it("is not shielded by a SIBLING profile's binding for the same symbol", async () => {
    await seedState('SIBBOUNDUSDT', '0');
    await bind('SIBBOUNDUSDT', siblingId);

    await pool.query(MIGRATION_SQL);

    expect(await survivors()).not.toContain('SIBBOUNDUSDT');
  });

  it("is not shielded by a SIBLING profile's open ledger row for the same symbol", async () => {
    await seedState('SIBHELDUSDT', '0');
    await seedLedger('SIBHELDUSDT', '3', siblingId);

    await pool.query(MIGRATION_SQL);

    expect(await survivors()).not.toContain('SIBHELDUSDT');
  });

  const conditions = async (owner = profileId): Promise<string[]> => {
    const res = await pool.query<{ symbol: string }>(
      `select symbol from condition_states where profile_id = $1 order by symbol`,
      [owner],
    );
    return res.rows.map((r) => r.symbol);
  };

  const seedCondition = async (symbol: string, owner = profileId): Promise<void> => {
    await pool.query(
      `insert into condition_states (profile_id, condition, symbol, code)
       values ($1, 'entryBlocker', $2, 'technicals-no-signal')`,
      [owner, symbol],
    );
  };

  // The operator-visible half. A `condition_states` row closes only when the owning tick writes a null code, and an unbound symbol never ticks again — so without this statement the profile keeps showing blockers for coins it does not hold, forever.
  it('deletes the open condition row for an unbound symbol and keeps the bound one', async () => {
    await seedCondition('CONDBOUNDUSDT');
    await bind('CONDBOUNDUSDT');
    await seedCondition('CONDLEAKEDUSDT');

    await pool.query(MIGRATION_SQL);

    const rows = await conditions();
    expect(rows).toContain('CONDBOUNDUSDT');
    expect(rows).not.toContain('CONDLEAKEDUSDT');
  });

  // `''` is the profile-level subject, not a symbol: it has no binding to resolve against and never had one, so the sentinel is exempt rather than swept.
  it('keeps the profile-level condition row, which has no symbol to bind', async () => {
    await pool.query(
      `insert into condition_states (profile_id, condition, symbol, code)
       values ($1, 'profileHalt', '', 'daily-loss')`,
      [profileId],
    );

    await pool.query(MIGRATION_SQL);

    expect(await conditions()).toContain('');
  });
});
