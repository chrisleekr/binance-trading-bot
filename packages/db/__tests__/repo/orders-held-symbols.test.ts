// listHeldSymbols feeds the max-open-positions cap. Each union leg gets its own symbol so a leg that stops contributing turns exactly one assertion red, and every decoy is a near-miss the query must reject.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeProfile } from '../../src/repo/index.js';
import { listHeldSymbols } from '../../src/repo/orders.js';
import * as schema from '../../src/schema/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

const CUTOFF = new Date('2026-01-01T12:00:00.000Z');
const BEFORE = new Date('2026-01-01T11:00:00.000Z');
const AFTER = new Date('2026-01-01T12:30:00.000Z');

describeIfDb('orders.listHeldSymbols', () => {
  let fx: IsolationFixture;
  const siblingProfileId = randomUUID();
  let nextOrderId = 9300000n;

  const order = (
    profileId: string,
    symbol: string,
    side: 'BUY' | 'SELL',
    status: string,
    createdAt: Date,
  ) => ({
    accountId: fx.alice.accountId,
    profileId,
    symbol,
    side,
    intent: `i-${nextOrderId}`,
    binanceOrderId: nextOrderId++,
    clientOrderId: `c-${nextOrderId}`,
    status,
    createdAt,
    raw: {},
  });

  beforeAll(async () => {
    fx = await setupFixture();
    await fx.db.insert(schema.profiles).values({
      id: siblingProfileId,
      accountId: fx.alice.accountId,
      name: 'sibling',
      strategyName: 'momentum',
      strategyVersion: '1.0.0',
      config: {},
      state: {},
    });
    const mine = fx.alice.profileId;
    await fx.db.insert(schema.avgEntryPrices).values([
      { profileId: mine, symbol: 'LEDGERUSDT', avgEntryPrice: '1', quantity: '1' },
      { profileId: mine, symbol: 'DUPUSDT', avgEntryPrice: '1', quantity: '1' },
      { profileId: siblingProfileId, symbol: 'SIBLEDGERUSDT', avgEntryPrice: '1', quantity: '1' },
    ]);
    await fx.db.insert(schema.orders).values([
      order(mine, 'RESTINGUSDT', 'BUY', 'NEW', BEFORE),
      order(mine, 'PARTIALUSDT', 'BUY', 'PARTIALLY_FILLED', BEFORE),
      order(mine, 'JUSTFILLEDUSDT', 'BUY', 'FILLED', AFTER),
      // Decoys: a FILLED BUY older than the cutoff, a SELL, a cancelled BUY, and a sibling's resting BUY.
      order(mine, 'OLDFILLUSDT', 'BUY', 'FILLED', BEFORE),
      order(mine, 'SELLONLYUSDT', 'SELL', 'NEW', AFTER),
      order(mine, 'CANCELEDUSDT', 'BUY', 'CANCELED', AFTER),
      order(siblingProfileId, 'SIBRESTINGUSDT', 'BUY', 'NEW', AFTER),
      // The same symbol via two legs must be reported once.
      order(mine, 'DUPUSDT', 'BUY', 'NEW', AFTER),
    ]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it('unions the ledger, resting BUYs and recently filled BUYs, once per symbol, for this profile only', async () => {
    const scope = await scopeProfile(
      fx.db,
      fx.alice.userId,
      fx.alice.accountId,
      fx.alice.profileId,
    );
    const held = await listHeldSymbols(scope, CUTOFF);
    expect([...held].sort()).toEqual([
      'DUPUSDT',
      'JUSTFILLEDUSDT',
      'LEDGERUSDT',
      'PARTIALUSDT',
      'RESTINGUSDT',
    ]);
  });
});
