import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, scopeProfile, type ProfileRepo } from '../../src/repo/index.js';
import { listLiveBinanceOrderIdsByAccount } from '../../src/repo/orders.js';
import { countOpenExposure } from '../../src/repo/projections/profile-exposure.js';
import { avgEntryPrices } from '../../src/schema/avg-entry-prices.js';
import { orders } from '../../src/schema/orders.js';
import { profiles } from '../../src/schema/profiles.js';
import { profileSymbols } from '../../src/schema/profile-symbols.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Happy-path matrix for the **mutation** paths in
 * `packages/db/src/repo/profiles.ts`. The mutations now take a
 * `ProfileScope`, so a wrong-owner call cannot be expressed — ownership is
 * proven once by `scopeProfile`. Cross-account rejection lives in
 * `cross-account.test.ts`; this suite locks the owner-scoped write
 * semantics for `setEnabled`, `update`, `switchStrategy`, `deleteById`.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on
 * workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// Suite is order-dependent — the last case deletes alice's profile. Do not
// `--shuffle` the runner.
describeIfDb('profiles mutation paths', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;

  beforeAll(async () => {
    fx = await setupFixture();
    ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('update mutates the owner-scoped row on the happy path', async () => {
    const result = await ap.profile.update({ name: 'alice-renamed' });
    expect(result?.name).toBe('alice-renamed');
  });

  it('commitState atomically writes state + strategy_version on the owner-scoped row', async () => {
    // The boot held-quantity reconciler routes its migrated-state write
    // here (#396); both columns must land together and the call must report
    // the row count so the caller can warn on a mid-flight deletion.
    const body = { schemaVersion: '9.9.9', marker: 'alice-state' };
    const updated = await ap.profile.commitState(body, '9.9.9');
    expect(updated).toBe(1);
    const row = await ap.profile.findById();
    expect(row?.state).toEqual(body);
    expect(row?.strategyVersion).toBe('9.9.9');
  });

  it('switchStrategy flips the owner-scoped row to disabled on the happy path', async () => {
    // Documented contract: switchStrategy forces `enabled = false` so the
    // worker pauses through the transition. Lock that here so a future
    // refactor cannot quietly drop the pause-on-swap invariant.
    await ap.profile.setEnabled(true);
    const result = await ap.profile.switchStrategy({
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.1',
      config: { tag: 'alice-new' },
      state: { tag: 'alice-new' },
    });
    expect(result?.strategyVersion).toBe('1.0.1');
    expect(result?.enabled).toBe(false);
  });

  it('switchStrategy purges the profile per-symbol state slices', async () => {
    // `symbol_states` stamps `strategy_version` but never the strategy NAME, so
    // a slice that outlives a swap is indistinguishable from one the incoming
    // strategy wrote. The worker's reconcile spine would then feed the outgoing
    // strategy's body to the incoming strategy. The swap must leave no slice
    // behind, so the next tick re-seeds from `initialState`.
    await ap.symbolStates.upsert('BTCUSDT', {
      state: { schemaVersion: '1.0.0', outgoing: true },
      strategyVersion: '1.0.0',
    });
    await ap.symbolStates.upsert('ETHUSDT', {
      state: { schemaVersion: '1.0.0', outgoing: true },
      strategyVersion: '1.0.0',
    });
    expect(await ap.symbolStates.listForProfile()).toHaveLength(2);

    await ap.profile.switchStrategy({
      strategyName: 'momentum',
      strategyVersion: '2.0.0',
      config: { tag: 'alice-momentum' },
      state: { tag: 'alice-momentum' },
    });

    expect(await ap.symbolStates.listForProfile()).toEqual([]);
    // Bob's slices are untouched: the purge is profile-scoped, not global.
    const bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await bp.symbolStates.upsert('BTCUSDT', {
      state: { schemaVersion: '1.0.0', bob: true },
      strategyVersion: '1.0.0',
    });
    await ap.profile.switchStrategy({
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.1',
      config: { tag: 'alice-back' },
      state: { tag: 'alice-back' },
    });
    expect(await bp.symbolStates.listForProfile()).toHaveLength(1);
  });

  it('deleteById removes the owner-scoped row on the happy path', async () => {
    const deleted = await ap.profile.deleteById();
    expect(deleted).toBe(true);

    const aliceRow = await ap.profile.findById();
    expect(aliceRow).toBeNull();

    // Bob's profile is untouched.
    const bobsRow = await repoFindBob(fx);
    expect(bobsRow).not.toBeNull();
  });

  it('table-level invariant: this fixture profiles rows still resolve to their owning user', async () => {
    // Scoped to this fixture's profiles — the `binance_test` database is
    // shared across parallel test files, so a global scan would race with
    // another suite's teardown. Alice's row was deleted above, so only
    // Bob's remains. A profile now resolves to its owner transitively:
    // profile.account_id → accounts.owner_id → users.id.
    const rows = await fx.db
      .select()
      .from(profiles)
      .where(inArray(profiles.id, [fx.alice.profileId, fx.bob.profileId]));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const owningAccounts = await fx.db.query.accounts.findMany({
        where: (a, { eq }) => eq(a.id, row.accountId),
      });
      expect(owningAccounts).toHaveLength(1);
      const owners = await fx.db.query.users.findMany({
        where: (u, { eq }) => eq(u.id, owningAccounts[0]!.ownerId),
      });
      expect(owners).toHaveLength(1);
    }
  });
});

// Bob's profile is read through its own scope — the deleted-alice case
// above asserts the delete did not cascade into Bob's row.
async function repoFindBob(fx: IsolationFixture) {
  const bp = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
  return bp.profile.findById();
}

// Deleting a profile drops its profile-owned subtree (ledger, symbol bindings)
// via the `ON DELETE CASCADE` FK chain — but NOT its orders. An order is
// account-domain: it keeps resting on Binance whether or not the profile that
// placed it still exists, so the cascade DETACHES it (`profile_id` -> NULL,
// `account_id` intact) instead of destroying the only record of a live exchange
// order. Lock both halves.
describeIfDb('profile delete cascades child rows, but DETACHES orders', () => {
  let fx: IsolationFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });
  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('deleteById removes the profile and all its child rows', async () => {
    const ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const pid = fx.alice.profileId;
    await fx.db
      .insert(profileSymbols)
      .values({ profileId: pid, symbol: 'BTCUSDT', baseAsset: 'BTC', source: 'manual' });
    await fx.db.insert(orders).values({
      accountId: fx.alice.accountId,
      profileId: pid,
      symbol: 'BTCUSDT',
      side: 'BUY',
      intent: 'manual',
      binanceOrderId: 9100001n,
      clientOrderId: 'cascade-order',
      status: 'NEW',
      raw: {},
    });
    await fx.db
      .insert(avgEntryPrices)
      .values({ profileId: pid, symbol: 'BTCUSDT', avgEntryPrice: '100', quantity: '1' });

    const deleted = await ap.profile.deleteById();
    expect(deleted).toBe(true);

    const symbolRows = await fx.db
      .select()
      .from(profileSymbols)
      .where(eq(profileSymbols.profileId, pid));
    expect(symbolRows).toHaveLength(0);
    // The order SURVIVES the delete, detached from the profile and still tied to
    // the account that can reconcile (or cancel) it on the exchange.
    const orphaned = await fx.db
      .select()
      .from(orders)
      .where(eq(orders.clientOrderId, 'cascade-order'));
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]?.profileId).toBeNull();
    expect(orphaned[0]?.accountId).toBe(fx.alice.accountId);
    // ... and it stays visible to the account's live-order reconciliation.
    const live = await listLiveBinanceOrderIdsByAccount(fx.db);
    expect(live.map((r) => r.binanceOrderId)).toContain(9100001n);
    const lbpRows = await fx.db
      .select()
      .from(avgEntryPrices)
      .where(eq(avgEntryPrices.profileId, pid));
    expect(lbpRows).toHaveLength(0);
  });
});

// `countOpenExposure` backs the delete-profile guard. It must count this
// profile's own live orders + held positions and never bleed across accounts.
describeIfDb('countOpenExposure is account-scoped', () => {
  let fx: IsolationFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });
  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('counts the owner profile and leaves a sibling account at zero', async () => {
    const pid = fx.alice.profileId;
    await fx.db
      .insert(profileSymbols)
      .values({ profileId: pid, symbol: 'BTCUSDT', baseAsset: 'BTC', source: 'manual' });
    await fx.db.insert(orders).values({
      accountId: fx.alice.accountId,
      profileId: pid,
      symbol: 'BTCUSDT',
      side: 'BUY',
      intent: 'manual',
      binanceOrderId: 9200001n,
      clientOrderId: 'exposure-order',
      status: 'NEW',
      raw: {},
    });
    await fx.db
      .insert(avgEntryPrices)
      .values({ profileId: pid, symbol: 'BTCUSDT', avgEntryPrice: '100', quantity: '2' });

    const aliceScope = await scopeProfile(
      fx.db,
      fx.alice.userId,
      fx.alice.accountId,
      fx.alice.profileId,
    );
    const alice = await countOpenExposure(aliceScope);
    expect(alice.openOrderCount).toBe(1);
    expect(alice.openPositionCount).toBe(1);

    const bobScope = await scopeProfile(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    const bob = await countOpenExposure(bobScope);
    expect(bob.openOrderCount).toBe(0);
    expect(bob.openPositionCount).toBe(0);
  });
});
