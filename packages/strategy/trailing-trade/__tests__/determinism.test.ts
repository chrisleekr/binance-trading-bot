import { describe, expect, it } from 'vitest';
import { assertDeterministic } from '@app/strategy-core/test';
import {
  trailingTrade,
  TTConfigSchema,
  TTBundleSchema,
  type TTConfig,
  type TTState,
  type TTBundle,
} from '../src/index.js';
import type { TickInput } from '@app/strategy-core';

const cfg = (): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '10' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });

// Two deep-cloned inputs every run so any accidental mutation inside
// tick() surfaces as a stableStringify divergence rather than a silent
// state leak between calls.
const makeInput = (): TickInput<TTConfig, TTState, TTBundle> => {
  const c = cfg();
  return {
    clock: { nowMs: () => 1_700_000_000_000 },
    rng: { next: () => 0.5 },
    trigger: { kind: 'tick' },
    profile: {
      id: 'p1',
      userId: 'u1',
      binanceMode: 'test',
      status: 'running',
      strategyVersion: '1.0.0',
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
          minNotional: '0',
          tickSize: '0.01',
          stepSize: '0.0001',
          minQty: '0',
          maxQty: '0',
          minPrice: '0',
          maxPrice: '0',
        },
      },
    },
    account: { balances: {}, readable: true },
    openOrders: [],
    bundle: TTBundleSchema.parse({
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
        signals: [{ interval: '1m', signal: null }],
      },
      override: null,
    }),
    limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
  };
};

describe('@app/strategy-trailing-trade — determinism gate', () => {
  it('two tick() calls with the same input produce byte-identical output', () => {
    // assertDeterministic throws on divergence; reaching the end of the
    // test body is the assertion. Internally it runs strategy.tick(input)
    // twice and compares stableStringify of both TickOutputs, so this
    // catches accidental Date.now() / Math.random() / module-level
    // counter leaks as well as any mutation of input.state between calls.
    assertDeterministic(trailingTrade, makeInput());
  });

  it('a fresh input on a separate call still converges to the same output', () => {
    // Running assertDeterministic twice with two independently-built
    // inputs catches state contamination across "sessions" — for
    // example, a module-level cache that persists between invocations.
    // Both calls must converge to the same byte-identical TickOutput
    // because the inputs are byte-identical, so capture each call's
    // `first` output and assert cross-call equality. Without this
    // comparison, only intra-call divergence was caught.
    const a = assertDeterministic(trailingTrade, makeInput());
    const b = assertDeterministic(trailingTrade, makeInput());
    expect(a.first).toEqual(b.first);
  });
});
