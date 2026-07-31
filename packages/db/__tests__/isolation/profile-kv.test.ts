import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Account-scoped matrix for `packages/db/src/repo/profile-kv.ts` (tracker #267).
 * `upsert` / `remove` / `snapshotForProfile` take a `ProfileScope`, so a
 * wrong-owner call cannot be expressed; the cross-profile read here is the
 * positive check that one profile's KV never leaks into another's snapshot.
 *
 * Skipped when `DATABASE_TEST_URL` is unset so `bun run test` works without PG.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('profile-kv account-scoped reads, writes, and isolation', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let bp: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('upsert then snapshot folds the rows into a key/value map', async () => {
    await ap.profileKv.upsert('rebalance:value:BTCUSDT', { quote: '1000.5' });
    await ap.profileKv.upsert('rebalance:value:ETHUSDT', { quote: '500' });
    expect(await ap.profileKv.snapshotForProfile()).toEqual({
      'rebalance:value:BTCUSDT': { quote: '1000.5' },
      'rebalance:value:ETHUSDT': { quote: '500' },
    });
  });

  it('upsert overwrites the value for an existing key (last-writer-wins)', async () => {
    await ap.profileKv.upsert('rebalance:value:BTCUSDT', { quote: '2000' });
    const snap = await ap.profileKv.snapshotForProfile();
    expect(snap['rebalance:value:BTCUSDT']).toEqual({ quote: '2000' });
  });

  it("a profile's snapshot never includes another profile's keys", async () => {
    await bp.profileKv.upsert('rebalance:value:BTCUSDT', { quote: '9999' });
    const aliceSnap = await ap.profileKv.snapshotForProfile();
    const bobSnap = await bp.profileKv.snapshotForProfile();
    expect(aliceSnap['rebalance:value:BTCUSDT']).toEqual({ quote: '2000' });
    expect(bobSnap['rebalance:value:BTCUSDT']).toEqual({ quote: '9999' });
    expect(bobSnap['rebalance:value:ETHUSDT']).toBeUndefined();
  });

  it('remove drops a key and is idempotent for an absent key', async () => {
    await ap.profileKv.remove('rebalance:value:ETHUSDT');
    await ap.profileKv.remove('rebalance:value:ETHUSDT'); // no-op, no throw
    const snap = await ap.profileKv.snapshotForProfile();
    expect(snap['rebalance:value:ETHUSDT']).toBeUndefined();
    expect(snap['rebalance:value:BTCUSDT']).toEqual({ quote: '2000' });
  });
});
