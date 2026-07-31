import { describe, expect, it } from 'vitest';
import type { OpenOrder, TickInput } from '@app/strategy-core';
import { buildScalars } from '../src/scalars.js';
import { trailingTrade } from '../src/index.js';
import { protectiveStopClientOrderId } from '../src/client-order-id.js';
import { TTConfigSchema, type TTBundle, type TTConfig, type TTState } from '../src/schema.js';

// buildScalars hoists the cross-branch reads the dispatcher threads into
// every branch. These tests pin the fields and, critically, that the clock
// is read exactly once (determinism: a replay must reproduce ticks byte-
// for-byte, so two reads of a moving clock would diverge).

const cfg = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });

const inputWith = (overrides?: {
  nowMs?: number;
  openOrders?: readonly OpenOrder[];
  clock?: { nowMs(): number };
}): TickInput<TTConfig, TTState, TTBundle> => {
  const c = cfg();
  return {
    clock: overrides?.clock ?? { nowMs: () => overrides?.nowMs ?? 0 },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: {
      id: 'p1',
      userId: 'u1',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '2.0.0',
    },
    config: c,
    state: trailingTrade.initialState(c),
    market: {
      symbol: 'BTCUSDT',
      currentPrice: '50000.00',
      candlesByInterval: {},
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: {
          minNotional: '10',
          tickSize: '0.01',
          stepSize: '0.0001',
          minQty: '0.0001',
          maxQty: '9000',
          minPrice: '0.01',
          maxPrice: '1000000',
        },
      },
    },
    account: { balances: {}, readable: true },
    openOrders: overrides?.openOrders ?? [],
    bundle: {
      technicals: {
        config: { useOnlyWithinMin: 5, ifExpires: 'do-not-buy', conditions: [] },
        signals: [],
      },
      override: null,
    },
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

const order = (side: 'BUY' | 'SELL', symbol = 'BTCUSDT', clientOrderId = 'c1'): OpenOrder =>
  ({
    symbol,
    side,
    orderId: 1,
    clientOrderId,
    price: '1',
    origQty: '1',
  }) as unknown as OpenOrder;

describe('buildScalars', () => {
  it('reads now from the injected clock', () => {
    const s = buildScalars(inputWith({ nowMs: 1_700_000 }));
    expect(s.now).toBe(1_700_000);
  });

  it('reflects open BUY / SELL orders for the symbol', () => {
    expect(buildScalars(inputWith()).hasOpenBuy).toBe(false);
    expect(buildScalars(inputWith()).hasOpenSell).toBe(false);
    const both = buildScalars(inputWith({ openOrders: [order('BUY'), order('SELL')] }));
    expect(both.hasOpenBuy).toBe(true);
    expect(both.hasOpenSell).toBe(true);
  });

  it('ignores orders for a different symbol', () => {
    const s = buildScalars(inputWith({ openOrders: [order('BUY', 'ETHUSDT')] }));
    expect(s.hasOpenBuy).toBe(false);
  });

  it('reads the injected clock exactly once', () => {
    let reads = 0;
    buildScalars(inputWith({ clock: { nowMs: () => ((reads += 1), 42) } }));
    expect(reads).toBe(1);
  });

  // hasOpenSell (via hasOpenSellForSymbol) must skip the strategy's OWN resting
  // protective stop — otherwise arming the backstop would freeze the in-process
  // stop-loss the moment the protective stop rests — while still blocking on any
  // foreign SELL already in flight.
  describe('hasOpenSell — own protective stop excluded', () => {
    const ownStopId = protectiveStopClientOrderId('p1', 'BTCUSDT');

    it('is false when only the own protective stop is resting', () => {
      const s = buildScalars(inputWith({ openOrders: [order('SELL', 'BTCUSDT', ownStopId)] }));
      expect(s.hasOpenSell).toBe(false);
    });

    it('is true when a foreign SELL is resting', () => {
      const s = buildScalars(inputWith({ openOrders: [order('SELL', 'BTCUSDT', 'foreign-sell')] }));
      expect(s.hasOpenSell).toBe(true);
    });

    it('is true when both the own protective stop and a foreign SELL are resting', () => {
      const s = buildScalars(
        inputWith({
          openOrders: [
            order('SELL', 'BTCUSDT', ownStopId),
            order('SELL', 'BTCUSDT', 'foreign-sell'),
          ],
        }),
      );
      expect(s.hasOpenSell).toBe(true);
    });
  });
});
