// Freshness gate (`useOnlyWithinMin` / `ifExpires`) lives on the strategy
// contract, so coverage lives next to the strategy rather than in a worker
// integration test. The boundary cases here are the assertion contract:
// `ageMs === maxAgeMs` is fresh, one millisecond more is stale.

import { describe, expect, it } from 'vitest';
import {
  trailingTrade,
  TTConfigSchema,
  TTBundleSchema,
  type TTConfig,
  type TTState,
  type TTBundle,
} from '../src/index.js';
import type { OpenOrder, TickInput } from '@app/strategy-core';

const NOW_MS = 1_700_000_000_000;
const USE_ONLY_WITHIN_MIN = 2;
const MAX_AGE_MS = USE_ONLY_WITHIN_MIN * 60_000;

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

type Sig = NonNullable<TTBundle['technicals']['signals'][number]['signal']>;

const bundleWith = (
  signal: Sig | null,
  ifExpires: TTBundle['technicals']['config']['ifExpires'] = 'do-not-buy',
  interval = '1m',
): TTBundle =>
  TTBundleSchema.parse({
    technicals: {
      config: {
        useOnlyWithinMin: USE_ONLY_WITHIN_MIN,
        ifExpires,
        intervals: [
          {
            interval,
            whenStrongBuy: true,
            whenBuy: true,
            whenSell: false,
            whenStrongSell: false,
            whenNeutral: false,
          },
        ],
      },
      signals: [{ interval, signal }],
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
      strategyVersion: '1.0.0',
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

describe('@app/strategy-trailing-trade Technicals freshness gate', () => {
  describe('just-fresh / just-stale boundary', () => {
    it('treats ageMs === maxAgeMs as fresh and emits place-order on BUY', () => {
      // Boundary: a signal exactly `useOnlyWithinMin` minutes old must still
      // pass the freshness gate. Using `>` not `>=` is the spec; flipping the
      // operator would silently shorten the window by one tick.
      const bundle = bundleWith({
        symbol: 'BTCUSDT',
        recommendation: 'BUY',
        receivedAtMs: NOW_MS - MAX_AGE_MS,
      });
      const out = trailingTrade.tick(baseInput({ bundle }));
      expect(out.decisions[0]?.type).toBe('place-order');
      expect(out.logs).toHaveLength(0);
    });

    it('treats ageMs === maxAgeMs + 1 as stale and vetoes with ifExpires=do-not-buy', () => {
      const receivedAtMs = NOW_MS - MAX_AGE_MS - 1;
      const bundle = bundleWith({
        symbol: 'BTCUSDT',
        recommendation: 'BUY',
        receivedAtMs,
      });
      const out = trailingTrade.tick(baseInput({ bundle }));
      expect(out.decisions[0]?.type).toBe('emit-event');
      expect(out.logs).toHaveLength(1);
      expect(out.logs[0]).toEqual({
        level: 'info',
        message: 'tt-technicals-gate-veto',
        context: {
          symbol: 'BTCUSDT',
          reason: 'technicals-stale',
          interval: '1m',
          recommendation: 'BUY',
          receivedAtMs,
          ageMs: MAX_AGE_MS + 1,
          useOnlyWithinMin: USE_ONLY_WITHIN_MIN,
          ifExpires: 'do-not-buy',
          // Per-interval breakdown added in iter49 — single interval here.
          intervalsConsulted: [
            { interval: '1m', recommendation: 'BUY', verdict: 'technicals-stale', advisory: false },
          ],
        },
      });
    });

    it('treats ageMs === maxAgeMs as fresh under allow-anyway too, so the boundary is symmetric', () => {
      // Mirrors the do-not-buy boundary case so a refactor that diverges
      // the two branches (e.g., off-by-one only on one side) shows up here.
      const bundle = bundleWith(
        { symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs: NOW_MS - MAX_AGE_MS },
        'allow-anyway',
      );
      const out = trailingTrade.tick(baseInput({ bundle }));
      expect(out.decisions[0]?.type).toBe('place-order');
    });
  });

  describe('ifExpires=do-not-buy', () => {
    it('vetoes a stale BUY and surfaces info-level processMessage with reason=technicals-stale', () => {
      const bundle = bundleWith({
        symbol: 'BTCUSDT',
        recommendation: 'BUY',
        receivedAtMs: NOW_MS - MAX_AGE_MS - 5_000,
      });
      const out = trailingTrade.tick(baseInput({ bundle }));
      expect(out.decisions[0]?.type).toBe('emit-event');
      expect(out.logs).toHaveLength(1);
      expect(out.logs[0]).toMatchObject({ level: 'info', context: { reason: 'technicals-stale' } });
    });

    it('emits a debug-level processMessage with reason=technicals-no-signal on boot/outage', () => {
      // Every veto reason is logged positively so dashboards never have to
      // infer state from log absence. Boot/no-signal is the common path so
      // it sits at debug; typical sinks drop debug by default, which is the
      // right behaviour for it but would have hidden a SELL veto.
      const out = trailingTrade.tick(baseInput({ bundle: bundleWith(null) }));
      expect(out.decisions[0]?.type).toBe('emit-event');
      expect(out.logs).toHaveLength(1);
      // Signal-derived keys are omitted on this branch — carrying placeholders
      // would mislead observers — so `toEqual` pins the full shape.
      expect(out.logs[0]).toEqual({
        level: 'debug',
        message: 'tt-technicals-gate-veto',
        context: {
          symbol: 'BTCUSDT',
          reason: 'technicals-no-signal',
          interval: '1m',
          useOnlyWithinMin: USE_ONLY_WITHIN_MIN,
          ifExpires: 'do-not-buy',
          // Per-interval breakdown added in iter49.
          intervalsConsulted: [
            {
              interval: '1m',
              recommendation: null,
              verdict: 'technicals-no-signal',
              advisory: false,
            },
          ],
        },
      });
    });
  });

  describe('ifExpires=allow-anyway', () => {
    it('bypasses freshness on a stale BUY and emits place-order MARKET', () => {
      const bundle = bundleWith(
        {
          symbol: 'BTCUSDT',
          recommendation: 'BUY',
          receivedAtMs: NOW_MS - MAX_AGE_MS - 60_000,
        },
        'allow-anyway',
      );
      const out = trailingTrade.tick(baseInput({ bundle }));
      expect(out.decisions[0]).toMatchObject({
        type: 'place-order',
        intent: { symbol: 'BTCUSDT', side: 'BUY', reason: 'grid-buy' },
        params: { type: 'MARKET' },
      });
      expect(out.logs).toHaveLength(0);
    });

    it.each(['STRONG_BUY', 'NEUTRAL'] as const)(
      'still evaluates the %s recommendation as if fresh under allow-anyway',
      (recommendation) => {
        const bundle = bundleWith(
          {
            symbol: 'BTCUSDT',
            recommendation,
            receivedAtMs: NOW_MS - MAX_AGE_MS - 10_000,
          },
          'allow-anyway',
        );
        const out = trailingTrade.tick(baseInput({ bundle }));
        expect(out.decisions[0]?.type).toBe('place-order');
      },
    );

    it('still vetoes on SELL even when stale + allow-anyway, with reason=technicals-sell', () => {
      // allow-anyway disarms the freshness check; the recommendation veto is
      // a separate rule and must keep firing — otherwise a stale STRONG_SELL
      // would slip through as a buy.
      const bundle = bundleWith(
        {
          symbol: 'BTCUSDT',
          recommendation: 'SELL',
          receivedAtMs: NOW_MS - MAX_AGE_MS - 10_000,
        },
        'allow-anyway',
      );
      const out = trailingTrade.tick(baseInput({ bundle }));
      expect(out.decisions[0]?.type).toBe('emit-event');
      expect(out.logs).toHaveLength(1);
      expect(out.logs[0]).toMatchObject({ level: 'info', context: { reason: 'technicals-sell' } });
    });

    it('still vetoes on STRONG_SELL even when stale + allow-anyway', () => {
      const bundle = bundleWith(
        {
          symbol: 'BTCUSDT',
          recommendation: 'STRONG_SELL',
          receivedAtMs: NOW_MS - MAX_AGE_MS - 10_000,
        },
        'allow-anyway',
      );
      const out = trailingTrade.tick(baseInput({ bundle }));
      expect(out.decisions[0]?.type).toBe('emit-event');
      expect(out.logs[0]?.context).toMatchObject({ reason: 'technicals-sell' });
    });
  });

  describe('forceBuyOverride bypass', () => {
    it('skips freshness entirely when checkTechnicals=false even on a deeply stale SELL', () => {
      // The override is the operator's escape hatch during a TV incident; it
      // must short-circuit BOTH the recommendation and freshness gates,
      // otherwise the rule is useless in the exact scenario it exists for.
      const bundle = bundleWith(
        {
          symbol: 'BTCUSDT',
          recommendation: 'STRONG_SELL',
          receivedAtMs: NOW_MS - MAX_AGE_MS - 600_000,
        },
        'do-not-buy',
      );
      const out = trailingTrade.tick(
        baseInput({
          bundle,
          config: TTConfigSchema.parse({
            symbol: 'BTCUSDT',
            buy: {
              enabled: true,
              entrySizing: { mode: 'fixed', amount: '50' },
              avgEntryPriceRemoveThreshold: '0',
            },
            sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
            forceBuyOverride: { checkTechnicals: false },
          }),
        }),
      );
      expect(out.decisions[0]?.type).toBe('place-order');
      expect(out.logs).toHaveLength(0);
    });
  });

  describe('clock-skew clamp', () => {
    it('treats a future-dated signal as fresh rather than indefinitely fresh by accident', () => {
      // Producer clocks can run a few seconds ahead of consumer clocks; the
      // negative ageMs that would result must clamp to zero so the
      // freshness check still has well-defined semantics. The test asserts
      // the gate passes (BUY recommendation), which is the same outcome as
      // a same-instant signal.
      const bundle = bundleWith({
        symbol: 'BTCUSDT',
        recommendation: 'BUY',
        receivedAtMs: NOW_MS + 5_000,
      });
      const out = trailingTrade.tick(baseInput({ bundle }));
      expect(out.decisions[0]?.type).toBe('place-order');
    });
  });

  describe('freshness log payload', () => {
    it('carries enough context to debug a misconfigured window without the source', () => {
      const receivedAtMs = NOW_MS - MAX_AGE_MS - 1;
      const bundle = bundleWith(
        { symbol: 'BTCUSDT', recommendation: 'BUY', receivedAtMs },
        'do-not-buy',
      );
      const out = trailingTrade.tick(baseInput({ bundle }));
      expect(out.logs[0]?.context).toMatchObject({
        symbol: 'BTCUSDT',
        reason: 'technicals-stale',
        receivedAtMs,
        useOnlyWithinMin: USE_ONLY_WITHIN_MIN,
        ifExpires: 'do-not-buy',
      });
    });
  });
});
