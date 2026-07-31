import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findBySymbols } from '../../src/repo/avg-entry-prices.js';
import { listLiveForSymbols } from '../../src/repo/orders.js';
import { accountRepo, profileRepo } from '../../src/repo/index.js';
import type { ProfileScope } from '../../src/repo/_scoped.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';

// The empty-list short-circuit is the one branch reachable without a database,
// so it gets CI-enforced coverage here (the DB-backed cases below gate on
// DATABASE_TEST_URL, which CI never sets). A throwing `db` proves neither
// function issues a query for an empty symbol list.
describe('batched per-symbol repo reads — empty short-circuit (no DB)', () => {
  const noQueryScope = {
    db: {
      select() {
        throw new Error('listLiveForSymbols issued a query for an empty symbol list');
      },
    },
    profileId: 'p',
  } as unknown as ProfileScope;

  it('returns [] for an empty symbol list without touching the db', async () => {
    expect(await listLiveForSymbols(noQueryScope, [])).toEqual([]);
    expect(await findBySymbols(noQueryScope, [])).toEqual([]);
  });
});

// Batched per-symbol reads that collapse the dashboard projections' P x S
// per-symbol fan-out into one query per concern per profile. DB-gated.
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('batched per-symbol repo reads', () => {
  let fx: IsolationFixture;

  beforeAll(async () => {
    fx = await setupFixture();
    const a = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    // BTCUSDT: one live grid-buy + one closed grid-sell (must be excluded) +
    // an LBP row. ETHUSDT: one live grid-buy, no LBP row.
    await a.avgEntryPrices.upsert('BTCUSDT', { avgEntryPrice: '60000', quantity: '0.001' });
    await a.orders.insert({
      symbol: 'BTCUSDT',
      side: 'BUY',
      intent: 'grid-buy',
      binanceOrderId: 1n,
      clientOrderId: 'b1',
      status: 'NEW',
      raw: {},
    });
    await a.orders.insert({
      symbol: 'BTCUSDT',
      side: 'SELL',
      intent: 'grid-sell',
      binanceOrderId: 2n,
      clientOrderId: 'b2',
      status: 'NEW',
      raw: {},
    });
    // Closing by Binance order id is ACCOUNT-scoped: the id is unique per account.
    const aAcct = await accountRepo(fx.db, fx.alice.userId, fx.alice.accountId);
    await aAcct.orders.closeByBinanceOrderId(2n, 'FILLED');
    await a.orders.insert({
      symbol: 'ETHUSDT',
      side: 'BUY',
      intent: 'grid-buy',
      binanceOrderId: 3n,
      clientOrderId: 'e1',
      status: 'NEW',
      raw: {},
    });
    // Bob's own BTCUSDT order — must never appear in Alice's batched read.
    const b = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    await b.orders.insert({
      symbol: 'BTCUSDT',
      side: 'BUY',
      intent: 'grid-buy',
      binanceOrderId: 9n,
      clientOrderId: 'bob1',
      status: 'NEW',
      raw: {},
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('listLiveForSymbols returns the live (non-closed) orders across the symbols, scoped to the profile', async () => {
    const a = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const live = await a.orders.listLiveForSymbols(['BTCUSDT', 'ETHUSDT']);
    const bySymbol = live.reduce<Record<string, number>>((m, o) => {
      m[o.symbol] = (m[o.symbol] ?? 0) + 1;
      return m;
    }, {});
    // 1 live BTCUSDT (the closed grid-sell excluded) + 1 ETHUSDT; bob's row excluded.
    expect(bySymbol).toEqual({ BTCUSDT: 1, ETHUSDT: 1 });
  });

  it('findBySymbols returns one LBP row per symbol that has one', async () => {
    const a = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    const lbps = await a.avgEntryPrices.findBySymbols(['BTCUSDT', 'ETHUSDT']);
    expect(lbps).toHaveLength(1);
    expect(lbps[0]?.symbol).toBe('BTCUSDT');
  });

  it('an empty symbol list short-circuits to [] without a query', async () => {
    const a = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    expect(await a.orders.listLiveForSymbols([])).toEqual([]);
    expect(await a.avgEntryPrices.findBySymbols([])).toEqual([]);
  });

  it("never leaks another profile's rows", async () => {
    const b = await profileRepo(fx.db, fx.bob.userId, fx.bob.accountId, fx.bob.profileId);
    const live = await b.orders.listLiveForSymbols(['BTCUSDT', 'ETHUSDT']);
    expect(live).toHaveLength(1);
    expect(live[0]?.symbol).toBe('BTCUSDT');
    expect(await b.avgEntryPrices.findBySymbols(['BTCUSDT'])).toEqual([]);
  });
});
