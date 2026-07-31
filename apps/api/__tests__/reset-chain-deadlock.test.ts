import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { HAS_INFRA, setupApp, resetDatabase, type ApiFixture } from './_helpers.js';

// Regression guard for the shared reset chain. The reset runs a wide `TRUNCATE
// ... RESTART IDENTITY CASCADE` then seed INSERTs. Two resets on independent
// sessions that overlap corrupt each other: one session's truncate wipes the
// other's freshly seeded rows (FK violation on its next insert), and the
// truncate CASCADE (profiles -> ... -> accounts -> users) versus the seed
// inserts (users -> accounts -> profiles) can lock the shared tables in opposing
// order and deadlock. In-process `resetChain` only orders resets within one
// worker; the full suite runs workers (= independent sessions) in parallel
// against the same container DB. `resetDatabase` wraps the whole reset in one
// transaction, so its truncate's ACCESS EXCLUSIVE locks serialise concurrent
// resets. This test drives many independent pools through `resetDatabase` at
// once and asserts the batch completes with NO error. Non-vacuity was confirmed
// by hand: reverting `resetDatabase` to the old autocommit form (each step its
// own statement, no transaction) makes this batch reliably reject with an
// FK violation or `deadlock detected`. The advisory lock alone is not the
// serialiser, so this test does not go red on its removal — it guards the
// transaction wrapper.

const describeIfInfra = HAS_INFRA ? describe : describe.skip;

describeIfInfra('concurrent setupApp reset chain does not deadlock', () => {
  let fx: ApiFixture;
  let databaseUrl: string;
  beforeAll(async () => {
    // setupApp provisions/migrates the shared infra; DATABASE_URL is the
    // resolved connection string (a random port under TESTCONTAINERS).
    fx = await setupApp();
    databaseUrl = fx.di.env.DATABASE_URL;
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  it('many independent sessions running resetDatabase concurrently never deadlock', async () => {
    // Independent pools = independent Postgres sessions; the shared di.pool would
    // be serialised by resetChain and never model the cross-worker race.
    const POOLS = 4;
    const ROUNDS = 60;
    const pools = Array.from({ length: POOLS }, () => new Pool({ connectionString: databaseUrl }));
    const runConcurrent = async (): Promise<void> => {
      for (let round = 0; round < ROUNDS; round++) {
        await Promise.all(pools.map((pool) => resetDatabase(pool)));
      }
    };
    try {
      // Serialised resets never clobber or deadlock each other, so the batch
      // resolves cleanly. Without the serialization this rejects (FK-violation
      // race, or a truncate/seed lock-order deadlock).
      await expect(runConcurrent()).resolves.toBeUndefined();
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
    }
  }, 120000);
});
