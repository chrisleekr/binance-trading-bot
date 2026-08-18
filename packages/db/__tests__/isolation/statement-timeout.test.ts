// Real-Postgres proof for the per-query budget helper.
//
// A fake `db.transaction` can only show that we emit a `set_config` statement. It cannot show that Postgres actually cancels the query, and it cannot show that the setting reverts when the transaction ends. Both are load-bearing: a bound that does not cancel leaves the caller waiting exactly as long as before, and a bound that leaks onto a pooled connection silently caps every later borrower of that connection.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import {
  assertTestDatabaseUrl,
  createDb,
  isStatementTimeout,
  withStatementTimeout,
  type Database,
} from '../../src/index.js';
import { TEST_DB_URL } from './_helpers.js';

/** Skipped when `DATABASE_TEST_URL` is unset so `bun run test` works without Postgres. */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// Small enough that pg_sleep below cannot finish inside it on any machine.
const TINY_TIMEOUT_MS = 100;

describeIfDb('withStatementTimeout against real Postgres', () => {
  let pool: Pool;
  let db: Database;

  beforeAll(() => {
    // Every other suite in this directory inherits this guard from `setupFixture`. This one opens its own pool, so it has to ask for itself: a stray DATABASE_TEST_URL pointed at the live database has truncated real data here before.
    assertTestDatabaseUrl(TEST_DB_URL ?? '');
    // One connection, so the leak case provably reuses the very connection the cancelled transaction ran on rather than happening to draw a clean one.
    pool = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    db = createDb(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('cancels a query that outlives the budget, and the rejection reads as a timeout', async () => {
    const err = await withStatementTimeout(db, TINY_TIMEOUT_MS, (tx) =>
      tx.execute(sql`select pg_sleep(3)`),
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(isStatementTimeout(err)).toBe(true);
  });

  it('leaves the next query on the same connection unbounded', async () => {
    // Self-contained on purpose: leaning on the case above would mean this one passes under `it.only`, a `-t` filter or any reordering without a timeout ever having been applied to the connection, which is the whole thing it claims to disprove.
    const cancelled = await withStatementTimeout(db, TINY_TIMEOUT_MS, (tx) =>
      tx.execute(sql`select pg_sleep(3)`),
    ).catch((e: unknown) => e);
    expect(isStatementTimeout(cancelled)).toBe(true);

    // The pool holds one connection, so this is the same backend that just carried the budget. `set_config(..., true)` is transaction-local and reverted at ROLLBACK; a session-level SET would have survived and cancelled this query too, since it outlives the tiny budget.
    await expect(db.execute(sql`select pg_sleep(0.3)`)).resolves.toBeDefined();
  });

  it('does not read an unrelated database fault as a timeout', async () => {
    // A classifier that always answered true would relabel every fault a timeout, and the outcome counts built on it would be fiction.
    const err = await db
      .execute(sql`select 1 from relation_that_does_not_exist_in_this_schema`)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(isStatementTimeout(err)).toBe(false);
  });
});
