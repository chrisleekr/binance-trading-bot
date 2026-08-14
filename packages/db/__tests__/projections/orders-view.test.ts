import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ProfileScope } from '../../src/repo/_scoped.js';
import { profileRepo } from '../../src/repo/index.js';
import {
  getSymbolArchive,
  getSymbolOrderHistory,
  getSymbolState,
  readEntryBlocker,
  readExitBlocker,
} from '../../src/repo/projections/orders-view.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from '../isolation/_helpers.js';
import { makeRedisStub } from './_redis-stub.js';

const describeIfDb = TEST_DB_URL ? describe : describe.skip;

describeIfDb('orders-view projections', () => {
  let fx: IsolationFixture;
  let scope: ProfileScope;
  let disableKey: string;

  beforeAll(async () => {
    fx = await setupFixture();
    const ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    scope = ap.scope;
    disableKey = `tenant:${fx.alice.accountId}:profile:${fx.alice.profileId}:disable-action:BTCUSDT`;
    await ap.avgEntryPrices.upsert('BTCUSDT', {
      avgEntryPrice: '60000',
      quantity: '0.001',
    });
    await ap.orders.insert({
      symbol: 'BTCUSDT',
      side: 'BUY',
      intent: 'grid-buy',
      binanceOrderId: 7n,
      clientOrderId: 'cli-ov',
      status: 'NEW',
      raw: {},
    });
    await ap.tradeArchive.insert({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      totalBuyQuote: '60000',
      totalSellQuote: '62000',
      breakdown: { 'grid-buy:BUY': '60000', 'grid-sell:SELL': '62000' },
      profit: '2000',
      profitPercent: '3.33',
      missingCostBasis: 1,
      orders: [{ side: 'BUY' as const }, { side: 'SELL' as const }],
      archivedAt: new Date('2026-05-11T00:00:00Z'),
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('getSymbolState returns strategy + lbp + open orders, null disable when the key is absent', async () => {
    const { redis } = makeRedisStub();
    const state = await getSymbolState(scope, redis, 'BTCUSDT');
    expect(state.strategy.name).toBe('trailing-trade');
    expect(Number(state.avgEntryPrice?.avgEntryPrice)).toBe(60000);
    expect(Number(state.avgEntryPrice?.quantity)).toBe(0.001);
    expect(state.openOrders).toHaveLength(1);
    expect(state.disable).toBeNull();
    // A seeded state without an entryBlocker reads as null.
    expect(state.entryBlocker).toBeNull();
  });

  it('getSymbolState surfaces a stored entryBlocker from the persisted state body', async () => {
    const ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await ap.symbolStates.upsert('BTCUSDT', {
      state: {
        avgEntryPrice: null,
        entryBlocker: {
          reason: 'awaiting-trigger-price',
          detail: { windowLow: '95', currentPrice: '96' },
        },
      },
      strategyVersion: '2.0.0',
    });
    const { redis } = makeRedisStub();
    const state = await getSymbolState(scope, redis, 'BTCUSDT');
    expect(state.entryBlocker).toEqual({
      reason: 'awaiting-trigger-price',
      detail: { windowLow: '95', currentPrice: '96' },
    });
  });

  it('getSymbolState surfaces a stored exitBlocker from the persisted state body', async () => {
    // The symbol screen reads this field instead of casting the opaque state
    // blob, so the whole record has to survive the projection, `hasDownsideExit`
    // included: it drives the "no exit below your entry" warning.
    const ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await ap.symbolStates.upsert('BTCUSDT', {
      state: {
        avgEntryPrice: '60000',
        exitBlocker: {
          reason: 'awaiting-sell-arm',
          detail: { armPrice: '63000', hasDownsideExit: false },
        },
      },
      strategyVersion: '2.0.0',
    });
    const { redis } = makeRedisStub();
    const state = await getSymbolState(scope, redis, 'BTCUSDT');
    expect(state.exitBlocker).toEqual({
      reason: 'awaiting-sell-arm',
      detail: { armPrice: '63000', hasDownsideExit: false },
    });
    // The two blockers answer different questions; this state has no entry one.
    expect(state.entryBlocker).toBeNull();
  });

  it('getSymbolState surfaces a disable with its remaining TTL', async () => {
    const { redis } = makeRedisStub();
    await redis.set(
      disableKey,
      JSON.stringify({ reason: 'manual', since: '2026-05-17T00:00:00.000Z' }),
      'EX',
      300,
    );
    const state = await getSymbolState(scope, redis, 'BTCUSDT');
    expect(state.disable).toEqual({
      ttlSeconds: 300,
      since: '2026-05-17T00:00:00.000Z',
      reason: 'manual',
    });
  });

  it('getSymbolState falls back to empty metadata on a malformed disable payload', async () => {
    const { redis } = makeRedisStub();
    await redis.set(disableKey, 'not-json', 'EX', 120);
    const state = await getSymbolState(scope, redis, 'BTCUSDT');
    expect(state.disable?.ttlSeconds).toBe(120);
    expect(state.disable?.reason).toBe('');
  });

  it('getSymbolState returns null strategy.state when the symbol has no symbol_states row', async () => {
    const { redis } = makeRedisStub();
    // No symbol_states row for ETHUSDT yet: the symbol has never ticked, so
    // there is no per-symbol slice to serve.
    const state = await getSymbolState(scope, redis, 'ETHUSDT');
    expect(state.strategy.state).toBeNull();
  });

  it('getSymbolState reads each symbol its own symbol_states slice (no cross-symbol leak)', async () => {
    const ap = await profileRepo(fx.db, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);
    await ap.symbolStates.upsert('BTCUSDT', {
      state: { avgEntryPrice: '60000', currentGridTradeIndex: 0 },
      strategyVersion: '2.0.0',
    });
    await ap.symbolStates.upsert('SOLUSDT', {
      state: { avgEntryPrice: '83.52', currentGridTradeIndex: 2 },
      strategyVersion: '2.0.0',
    });
    const { redis } = makeRedisStub();
    const btc = await getSymbolState(scope, redis, 'BTCUSDT');
    expect(btc.strategy.state).toEqual({ avgEntryPrice: '60000', currentGridTradeIndex: 0 });
    // The #253 contamination is now structurally impossible: SOLUSDT reads its
    // own row, never BTCUSDT's.
    const sol = await getSymbolState(scope, redis, 'SOLUSDT');
    expect(sol.strategy.state).toEqual({ avgEntryPrice: '83.52', currentGridTradeIndex: 2 });
    // A symbol with no row stays null even when siblings hold state.
    const eth = await getSymbolState(scope, redis, 'ETHUSDT');
    expect(eth.strategy.state).toBeNull();
  });

  it('getSymbolOrderHistory maps order rows to the wire shape', async () => {
    const history = await getSymbolOrderHistory(scope, 'BTCUSDT', 50);
    expect(history.items.length).toBeGreaterThanOrEqual(1);
    expect(history.items[0]).toMatchObject({ symbol: 'BTCUSDT', side: 'BUY', intent: 'grid-buy' });
  });

  it('getSymbolArchive maps archive rows to the wire shape', async () => {
    const archive = await getSymbolArchive(scope, 'BTCUSDT', 50);
    expect(archive.items).toHaveLength(1);
    // The whole wire shape, not just two fields: `missingCostBasis` is what the
    // UI switches on to say "P/L unavailable", and `netProfit` is derived here
    // rather than stored, so dropping either mapping has to fail this.
    expect(archive.items[0]).toMatchObject({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      missingCostBasis: 1,
      exitIntent: 'unknown',
    });
    expect(Number(archive.items[0]?.totalBuyQuote)).toBe(60000);
    expect(Number(archive.items[0]?.totalSellQuote)).toBe(62000);
    expect(Number(archive.items[0]?.profitPercent)).toBe(3.33);
    expect(Number(archive.items[0]?.netProfit)).toBe(2000);
  });
});

// Pure decoder — no DB, runs without infra. The discovery route enriches its
// dashboard payload through this reader, so its defensive paths are covered here
// independent of the infra-gated route test.
describe('readEntryBlocker', () => {
  it('reads a well-formed blocker with its detail', () => {
    const state = {
      entryBlocker: { reason: 'awaiting-trigger-price', detail: { windowLow: '95' } },
    };
    expect(readEntryBlocker(state)).toEqual({
      reason: 'awaiting-trigger-price',
      detail: { windowLow: '95' },
    });
  });

  it('reads a reason-only blocker, omitting an absent detail', () => {
    expect(readEntryBlocker({ entryBlocker: { reason: 'exposure-cap' } })).toEqual({
      reason: 'exposure-cap',
    });
  });

  it('returns null when the state omits entryBlocker or stores it malformed', () => {
    expect(readEntryBlocker({ entryBlocker: null })).toBeNull();
    expect(readEntryBlocker({})).toBeNull();
    expect(readEntryBlocker({ entryBlocker: { detail: { x: 1 } } })).toBeNull(); // no string reason
    expect(readEntryBlocker(null)).toBeNull();
    expect(readEntryBlocker('not-an-object')).toBeNull();
  });
});

describe('readExitBlocker', () => {
  it('reads a well-formed blocker with its detail', () => {
    const state = {
      exitBlocker: { reason: 'awaiting-sell-arm', detail: { armPrice: '105' } },
      entryBlocker: { reason: 'exposure-cap' },
    };
    // Keyed off its own field: the exit-side record answers a different question
    // from the entry-side one and must never pick up its neighbour's reason.
    expect(readExitBlocker(state)).toEqual({
      reason: 'awaiting-sell-arm',
      detail: { armPrice: '105' },
    });
  });

  it('carries hasDownsideExit through to the client verbatim', () => {
    // The symbol panel warns "no exit below your entry" off this flag rather
    // than re-deriving it from config, so the projection must not filter or
    // coerce the detail body it was handed.
    expect(
      readExitBlocker({
        exitBlocker: { reason: 'awaiting-sell-arm', detail: { hasDownsideExit: false } },
      }),
    ).toEqual({ reason: 'awaiting-sell-arm', detail: { hasDownsideExit: false } });
  });

  it('reads a reason-only blocker, omitting an absent detail', () => {
    expect(readExitBlocker({ exitBlocker: { reason: 'stop-loss-not-hit' } })).toEqual({
      reason: 'stop-loss-not-hit',
    });
  });

  it('returns null when the state omits exitBlocker or stores it malformed', () => {
    expect(readExitBlocker({ exitBlocker: null })).toBeNull();
    expect(readExitBlocker({})).toBeNull();
    expect(readExitBlocker({ exitBlocker: { detail: { x: 1 } } })).toBeNull(); // no string reason
    expect(readExitBlocker(null)).toBeNull();
    expect(readExitBlocker('not-an-object')).toBeNull();
  });
});
