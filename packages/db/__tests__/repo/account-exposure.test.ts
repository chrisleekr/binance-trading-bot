// countAccountOpenExposure: the guard behind a destructive account delete.
// Deleting an account cascades away every profile's orders and ledger rows, so
// the count must span ALL profiles under the account (not just one), and must
// never see a sibling account's exposure — a false positive would block a
// legitimate delete, a false negative would strand real orders on Binance.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeAccount } from '../../src/repo/index.js';
import { countAccountOpenExposure } from '../../src/repo/projections/index.js';
import * as schema from '../../src/schema/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('countAccountOpenExposure', () => {
  let fx: IsolationFixture;
  // A SECOND profile under alice's account: the account-wide count must pick up
  // exposure here too, which a per-profile count on the first profile would miss.
  const siblingProfileId = randomUUID();

  beforeAll(async () => {
    fx = await setupFixture();
    await fx.db.insert(schema.profiles).values({
      id: siblingProfileId,
      accountId: fx.alice.accountId,
      name: 'sibling',
      strategyName: 'trailing-trade',
      strategyVersion: '2.0.0',
      config: {},
      state: {},
    });

    // One live order on alice's first profile.
    await fx.db.insert(schema.orders).values({
      accountId: fx.alice.accountId,
      profileId: fx.alice.profileId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      intent: 'manual',
      binanceOrderId: 8100001n,
      clientOrderId: 'acct-exposure-a',
      status: 'NEW',
      raw: {},
    });
    // One held position on the SIBLING profile of the same account.
    await fx.db.insert(schema.avgEntryPrices).values({
      profileId: siblingProfileId,
      symbol: 'ETHUSDT',
      avgEntryPrice: '100',
      quantity: '1',
      updatedAt: new Date(),
    });
    // Bob's account carries its own exposure; alice's count must not see it.
    await fx.db.insert(schema.orders).values({
      accountId: fx.bob.accountId,
      profileId: fx.bob.profileId,
      symbol: 'BNBUSDT',
      side: 'BUY',
      intent: 'manual',
      binanceOrderId: 8100002n,
      clientOrderId: 'acct-exposure-b',
      status: 'NEW',
      raw: {},
    });
    await fx.db.insert(schema.avgEntryPrices).values({
      profileId: fx.bob.profileId,
      symbol: 'BNBUSDT',
      avgEntryPrice: '50',
      quantity: '3',
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('counts open orders and held positions across every profile of the account', async () => {
    const scope = await scopeAccount(fx.db, fx.alice.userId, fx.alice.accountId);
    expect(await countAccountOpenExposure(scope)).toEqual({
      openOrderCount: 1,
      openPositionCount: 1,
    });
  });

  it('still counts a DETACHED order — the exposure a deleted profile left on the exchange', async () => {
    // An order whose profile was deleted (profile_id NULL) may STILL be resting on
    // Binance. It is exactly the exposure this guard exists to refuse deleting the
    // account over, so counting through a `profiles` join would silently drop it
    // and let the cascade erase the only record of a live exchange order.
    await fx.db.insert(schema.orders).values({
      accountId: fx.alice.accountId,
      profileId: null,
      symbol: 'SOLUSDT',
      side: 'BUY',
      intent: 'manual',
      binanceOrderId: 8100003n,
      clientOrderId: 'acct-exposure-detached',
      status: 'NEW',
      raw: {},
    });

    const scope = await scopeAccount(fx.db, fx.alice.userId, fx.alice.accountId);
    const exposure = await countAccountOpenExposure(scope);
    // The attached order from the seed, plus the detached one.
    expect(exposure.openOrderCount).toBe(2);
  });

  it("does not leak another account's exposure", async () => {
    const scope = await scopeAccount(fx.db, fx.bob.userId, fx.bob.accountId);
    // Bob's own numbers, unaffected by alice's two rows above.
    expect(await countAccountOpenExposure(scope)).toEqual({
      openOrderCount: 1,
      openPositionCount: 1,
    });
  });
});
