import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asProfileId } from '@app/contracts';

import { accountRepo, profileRepo, type AccountScope } from '../../src/repo/index.js';
import {
  getAggregateForAccount,
  // Issue #649 C2/E10: the account-scoped, set-based rollup that collapses the
  // per-(profile × symbol) fan-out of getAggregateForAccount into ~4 fixed
  // account-scoped queries (JOIN profiles WHERE account_id). It does NOT exist
  // yet — Phase B adds it (in avg-entry-prices.ts / orders.ts, re-exported here)
  // and registers it in ast-check's ACCOUNT_LEVEL_FUNCTIONS. Until then this
  // import fails to resolve, so the whole file is RED (module-link error under
  // vitest + a tsc "no exported member" error). That is the intended start
  // state — DO NOT implement the function to make this pass in Phase A.
  rollupAllProfilesForAccount,
} from '../../src/repo/projections/profile-aggregate.js';
import * as schema from '../../src/schema/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';
import { makeRedisStub } from './_redis-stub.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

// Non-DB existence guard so the scaffold is observably RED in every environment
// (the equivalence body below is DB-gated; `__tests__` is excluded from tsc, so
// the unresolved import alone would otherwise be a silent no-op without a DB).
// RED now: the import resolves to `undefined` until Phase B adds and re-exports
// `rollupAllProfilesForAccount`. DO NOT implement it in Phase A.
describe('rollupAllProfilesForAccount is exported (E10 scaffold)', () => {
  it('exists as an account-scoped rollup function', () => {
    expect(typeof rollupAllProfilesForAccount).toBe('function');
  });
});

// Equivalence gate: the new set-based rollup must return, per profile, the SAME
// {openOrderCount, openPositionCount, positions} the current per-profile
// rollupFor path yields (as surfaced through getAggregateForAccount). Seeded on
// a TWO-profile account so the collapse is exercised across profiles, not just
// one row.
describeIfDb('rollupAllProfilesForAccount ≡ per-profile rollup (E10)', () => {
  let fx: IsolationFixture;
  let aliceAccount: AccountScope;
  let secondProfileId: string;

  beforeAll(async () => {
    fx = await setupFixture();
    aliceAccount = (await accountRepo(fx.db, fx.alice.userId, fx.alice.accountId)).scope;

    // The fixture seeds one profile per account; add a second under alice's
    // account so the account-scoped rollup spans two profiles.
    secondProfileId = randomUUID();
    await fx.db.insert(schema.profiles).values({
      id: secondProfileId,
      accountId: fx.alice.accountId,
      name: 'demo-2',
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: {},
    });

    // Profile 1: one held position + one live order.
    const p1 = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await p1.profileSymbols.upsert('BTCUSDT', 'BTC', { overrideConfig: null });
    await p1.avgEntryPrices.upsert('BTCUSDT', { avgEntryPrice: '60000', quantity: '0.001' });
    await p1.orders.insert({
      symbol: 'BTCUSDT',
      side: 'BUY',
      intent: 'grid-buy',
      binanceOrderId: 11n,
      clientOrderId: 'cli-r1',
      status: 'NEW',
      raw: {},
    });

    // Profile 2: a different held position, no live order.
    const p2 = await profileRepo(
      fx.db,
      fx.alice.userId,
      fx.alice.accountId,
      asProfileId(secondProfileId),
    );
    await p2.profileSymbols.upsert('ETHUSDT', 'ETH', { overrideConfig: null });
    await p2.avgEntryPrices.upsert('ETHUSDT', { avgEntryPrice: '3000', quantity: '0.5' });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('yields the same per-profile counts and positions as getAggregateForAccount', async () => {
    const { redis } = makeRedisStub({
      'ticker:BTCUSDT': JSON.stringify({ price: '61000' }),
      'ticker:ETHUSDT': JSON.stringify({ price: '3100' }),
    });

    const aggregate = await getAggregateForAccount(aliceAccount, redis);
    const rollups = await rollupAllProfilesForAccount(aliceAccount, redis);

    // Phase B contract (asserted here to pin the design): the new function keys
    // its rollup by profileId and each value is the {openOrderCount,
    // openPositionCount, positions} triple. Compare it against the same fields
    // getAggregateForAccount already projects per profile.
    for (const profile of aggregate.profiles) {
      const rollup = rollups.get(profile.profileId);
      expect(rollup).toBeDefined();
      expect(rollup?.openOrderCount).toBe(profile.openOrderCount);
      expect(rollup?.openPositionCount).toBe(profile.openPositionCount);
      expect(rollup?.positions).toEqual(profile.positions);
    }
  });
});
