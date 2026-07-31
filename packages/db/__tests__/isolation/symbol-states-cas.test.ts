import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Optimistic-concurrency (CAS) contract for `symbol_states.casUpsert` against a
 * real Postgres. This is the cross-pod-safety keystone: under BullMQ competing
 * consumers two pods can run a read-modify-write of the same (profile, symbol)
 * slice concurrently, and only the DB `WHERE version = :expected` predicate
 * (not the in-process chainByKey) prevents a lost update. Proven here with
 * genuinely concurrent transactions, not a serial stand-in.
 *
 * Skipped when `DATABASE_TEST_URL` is not set.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const body = (v: string) => ({ state: { schemaVersion: '1.0.0', v }, strategyVersion: '1.0.0' });

describeIfDb('symbol_states optimistic-concurrency (casUpsert)', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('seeds a row at version 0 when none exists (expectedVersion=null)', async () => {
    const row = await ap.symbolStates.casUpsert('SEEDUSDT', body('seed'), null);
    expect(row?.version).toBe(0);
    expect((row?.state as { v: string }).v).toBe('seed');
  });

  it('a second insert on an existing row is a CAS miss (null)', async () => {
    // A row now exists at version 0; another seed (expectedVersion=null) must
    // NOT clobber it — ON CONFLICT DO NOTHING returns no row.
    const miss = await ap.symbolStates.casUpsert('SEEDUSDT', body('second-seed'), null);
    expect(miss).toBeNull();
    const current = await ap.symbolStates.findBySymbol('SEEDUSDT');
    expect((current?.state as { v: string }).v).toBe('seed'); // unchanged
  });

  it('applies at the expected version and increments it', async () => {
    const updated = await ap.symbolStates.casUpsert('SEEDUSDT', body('v1'), 0);
    expect(updated?.version).toBe(1);
    expect((updated?.state as { v: string }).v).toBe('v1');
  });

  it('rejects a stale expectedVersion (null miss, row untouched)', async () => {
    // The row is at version 1; a writer that read version 0 must lose.
    const stale = await ap.symbolStates.casUpsert('SEEDUSDT', body('stale'), 0);
    expect(stale).toBeNull();
    const current = await ap.symbolStates.findBySymbol('SEEDUSDT');
    expect(current?.version).toBe(1);
    expect((current?.state as { v: string }).v).toBe('v1'); // stale write did not land
  });

  it('two concurrent writers at the same version: exactly one wins', async () => {
    await ap.symbolStates.casUpsert('RACEUSDT', body('base'), null); // version 0
    // Both read version 0 and race the update. Postgres serialises the two
    // UPDATE ... WHERE version = 0 statements: one matches the row and bumps
    // it to 1, the other now matches zero rows and returns null.
    const [a, b] = await Promise.all([
      ap.symbolStates.casUpsert('RACEUSDT', body('writer-a'), 0),
      ap.symbolStates.casUpsert('RACEUSDT', body('writer-b'), 0),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1); // exactly one applied
    const final = await ap.symbolStates.findBySymbol('RACEUSDT');
    expect(final?.version).toBe(1); // bumped exactly once, no lost update
    expect((winners[0]?.state as { v: string }).v).toBe((final?.state as { v: string }).v); // the winner's body is the durable body
  });

  it('two concurrent seeders of a fresh symbol: exactly one inserts', async () => {
    const [a, b] = await Promise.all([
      ap.symbolStates.casUpsert('FRESHUSDT', body('seeder-a'), null),
      ap.symbolStates.casUpsert('FRESHUSDT', body('seeder-b'), null),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
    const final = await ap.symbolStates.findBySymbol('FRESHUSDT');
    expect(final?.version).toBe(0);
  });
});
