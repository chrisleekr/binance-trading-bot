// Force-buy override lives on the strategy contract, so its dedicated
// coverage lives here rather than in a worker test that would only
// re-test the same pure tick().

import { describe, expect, it } from 'vitest';
import {
  trailingTrade,
  TTConfigSchema,
  type TTConfig,
  type TTState,
  type TTBundle,
} from '../src/index.js';
import { TTBundleSchema } from '../src/index.js';
import type { OpenOrder, TickInput } from '@app/strategy-core';

type TVRecommendation = 'BUY' | 'SELL' | 'NEUTRAL' | 'STRONG_BUY' | 'STRONG_SELL';

// Anchor the simulated clock and signal arrival inside the 2-minute
// freshness window. Today the strategy ignores `receivedAtMs` (the
// `useOnlyWithinMin` / `ifExpires` rule is documented as not implemented
// yet), so the gap below is the assertion contract: when freshness lands,
// these tests must continue to exercise the SELL gating path, not an
// expired-signal branch.
const NOW_MS = 1_700_000_000_000;
const FRESH_RECEIVED_AT_MS = NOW_MS - 30_000;

const cfg = (overrides?: { checkTechnicals?: boolean }): TTConfig => {
  const raw: Record<string, unknown> = {
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  };
  if (overrides?.checkTechnicals !== undefined) {
    raw.forceBuyOverride = { checkTechnicals: overrides.checkTechnicals };
  }
  return TTConfigSchema.parse(raw);
};

type Sig = NonNullable<TTBundle['technicals']['signals'][number]['signal']>;

const bundleWith = (signal: Sig | null): TTBundle =>
  TTBundleSchema.parse({
    technicals: {
      config: {
        useOnlyWithinMin: 2,
        ifExpires: 'do-not-buy',
        intervals: [
          {
            interval: '1m',
            whenStrongBuy: true,
            whenBuy: true,
            whenSell: false,
            whenStrongSell: false,
            whenNeutral: false,
          },
        ],
      },
      signals: [{ interval: '1m', signal }],
    },
    override: null,
  });

const baseInput = (overrides?: {
  bundle?: TTBundle;
  state?: TTState;
  config?: TTConfig;
  openOrders?: readonly OpenOrder[];
}): TickInput<TTConfig, TTState, TTBundle> => {
  const c = overrides?.config ?? cfg();
  return {
    clock: { nowMs: () => NOW_MS },
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
    state: overrides?.state ?? trailingTrade.initialState(c),
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
    bundle: overrides?.bundle ?? bundleWith(null),
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

describe('@app/strategy-trailing-trade forceBuyOverride.checkTechnicals', () => {
  it('defaults to checkTechnicals=true so a fresh profile keeps the TV veto on', () => {
    // Operators have to flip the flag deliberately; an absent field must
    // never disarm the gate by accident.
    expect(cfg().forceBuyOverride.checkTechnicals).toBe(true);
  });

  it.each<TVRecommendation>(['SELL', 'STRONG_SELL'])(
    'emits place-order MARKET BUY despite TV %s when checkTechnicals=false',
    (recommendation) => {
      const bundle = bundleWith({
        symbol: 'BTCUSDT',
        recommendation,
        receivedAtMs: FRESH_RECEIVED_AT_MS,
      });
      const out = trailingTrade.tick(
        baseInput({ bundle, config: cfg({ checkTechnicals: false }) }),
      );
      expect(out.decisions).toHaveLength(1);
      expect(out.decisions[0]).toMatchObject({
        type: 'place-order',
        intent: {
          symbol: 'BTCUSDT',
          side: 'BUY',
          reason: 'grid-buy',
        },
        params: { type: 'MARKET' },
      });
    },
  );

  it('emits place-order MARKET BUY when TV signal is null and checkTechnicals=false', () => {
    // signal=null is the safety-veto path on the default config (TV
    // unavailable, no buy). The override has to bypass this too,
    // otherwise the operator could not place a manual buy during a TV
    // outage, which is the very scenario the override exists for.
    const out = trailingTrade.tick(
      baseInput({ bundle: bundleWith(null), config: cfg({ checkTechnicals: false }) }),
    );
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'BUY', reason: 'grid-buy' },
    });
  });

  it('still blocks the buy on TV SELL when checkTechnicals is explicitly true', () => {
    // Mirror of the override-off path so a refactor that inverts the flag
    // direction surfaces here instead of in production.
    const bundle = bundleWith({
      symbol: 'BTCUSDT',
      recommendation: 'SELL',
      receivedAtMs: FRESH_RECEIVED_AT_MS,
    });
    const out = trailingTrade.tick(baseInput({ bundle, config: cfg({ checkTechnicals: true }) }));
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.type).toBe('emit-event');
  });

  it('does not bypass the avgEntryPrice gate: override=false still respects an existing position', () => {
    // The override disarms the TV gate only. Re-buying when the strategy
    // already holds a position would double-spend the budget, so the
    // avgEntryPrice check must remain authoritative regardless of the flag.
    const bundle = bundleWith({
      symbol: 'BTCUSDT',
      recommendation: 'SELL',
      receivedAtMs: FRESH_RECEIVED_AT_MS,
    });
    const state: TTState = {
      schemaVersion: '2.0.0',
      avgEntryPrice: '49000.00',
      disabledUntilMs: null,
      triggers: { override: null },
    };
    const out = trailingTrade.tick(
      baseInput({ bundle, state, config: cfg({ checkTechnicals: false }) }),
    );
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.type).toBe('emit-event');
  });

  it('does not bypass the open-buy gate: override=false still defers when an open BUY exists', () => {
    // Same rationale as the avgEntryPrice gate. The override targets the
    // TV signal, not the order-book invariants that prevent overlapping
    // first-buy attempts for one (profile, symbol).
    const bundle = bundleWith({
      symbol: 'BTCUSDT',
      recommendation: 'SELL',
      receivedAtMs: FRESH_RECEIVED_AT_MS,
    });
    const openOrders: readonly OpenOrder[] = [
      {
        orderId: 7,
        clientOrderId: 'existing-buy',
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        status: 'NEW',
        price: '49000',
        origQty: '0.0001',
        executedQty: '0',
        cummulativeQuoteQty: '0',
        transactTimeMs: 0,
        updateTimeMs: 0,
      },
    ];
    const out = trailingTrade.tick(
      baseInput({ bundle, openOrders, config: cfg({ checkTechnicals: false }) }),
    );
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]?.type).toBe('emit-event');
  });
});
