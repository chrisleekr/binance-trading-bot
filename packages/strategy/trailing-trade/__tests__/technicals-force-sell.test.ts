// Force-sell-on-Technicals evaluator. The rules covered here:
// (1) at-least-one configured interval whose `when{Sell,StrongSell,Neutral}`
// matches the live recommendation, (2) position is in profit, (3) current
// price is below the configured sell-trigger price, (4) the matched signal
// is fresh per `useOnlyWithinMin`. Stale signals never trigger force-sell
// regardless of `ifExpires` — that field is buy-side only.

import { describe, expect, it } from 'vitest';
import { evaluateTechnicalsForceSell } from '../src/technicals-force-sell.js';
import type { TechnicalsBundle } from '@app/contracts';
import { Decimal } from '@app/money';

const NOW_MS = 1_700_000_000_000;

const intervalRow = (
  interval: string,
  overrides?: Partial<{
    whenStrongBuy: boolean;
    whenBuy: boolean;
    whenSell: boolean;
    whenStrongSell: boolean;
    whenNeutral: boolean;
  }>,
) => ({
  interval,
  whenStrongBuy: true,
  whenBuy: true,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
  ...overrides,
});

const tv = (
  intervalRows: ReturnType<typeof intervalRow>[],
  signals: { interval: string; signal: TechnicalsBundle['signals'][number]['signal'] }[],
  useOnlyWithinMin = 2,
): TechnicalsBundle => ({
  config: { useOnlyWithinMin, ifExpires: 'do-not-buy', intervals: intervalRows },
  signals,
});

const sig = (
  recommendation: 'BUY' | 'SELL' | 'STRONG_SELL' | 'NEUTRAL' | 'STRONG_BUY',
  ageMs = 0,
) => ({
  symbol: 'BTCUSDT',
  recommendation,
  maRecommendation: null,
  oscRecommendation: null,
  receivedAtMs: NOW_MS - ageMs,
  indicators: null,
});

describe('evaluateTechnicalsForceSell', () => {
  it('returns ok=false when no position is held', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m', { whenStrongSell: true })],
        [{ interval: '1m', signal: sig('STRONG_SELL') }],
      ),
      currentPrice: '100',
      avgEntryPrice: null,
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out.ok).toBe(false);
  });

  it('returns ok=false when a price parses to a non-finite Decimal', () => {
    // decimal.js accepts 'Infinity' without throwing, so the catch never
    // fires; the explicit isFinite guard is what rejects it.
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m', { whenStrongSell: true })],
        [{ interval: '1m', signal: sig('STRONG_SELL') }],
      ),
      currentPrice: 'Infinity',
      avgEntryPrice: '90',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out.ok).toBe(false);
  });

  it('returns ok=false when intervals list is empty (operator opted out)', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv([], []),
      currentPrice: '102',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out.ok).toBe(false);
  });

  it('returns ok=false when current price is at or above the sell trigger', () => {
    // The normal sell ladder handles at-or-above-trigger; force-sell only
    // fires when price is below it.
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m', { whenStrongSell: true })],
        [{ interval: '1m', signal: sig('STRONG_SELL') }],
      ),
      currentPrice: '105',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out.ok).toBe(false);
  });

  it('returns ok=false when the position is at or below cost (no force-sell at a loss)', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m', { whenStrongSell: true })],
        [{ interval: '1m', signal: sig('STRONG_SELL') }],
      ),
      currentPrice: '100',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out.ok).toBe(false);
  });

  it('fires when a configured whenStrongSell interval reports STRONG_SELL and guards pass', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m', { whenStrongSell: true })],
        [{ interval: '1m', signal: sig('STRONG_SELL') }],
      ),
      currentPrice: '102',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out).toMatchObject({ ok: true, interval: '1m', recommendation: 'STRONG_SELL' });
  });

  it('fires on SELL when whenSell is configured', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv([intervalRow('1m', { whenSell: true })], [{ interval: '1m', signal: sig('SELL') }]),
      currentPrice: '102',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out).toMatchObject({ ok: true, interval: '1m', recommendation: 'SELL' });
  });

  it('fires on NEUTRAL when whenNeutral is configured', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m', { whenNeutral: true })],
        [{ interval: '1m', signal: sig('NEUTRAL') }],
      ),
      currentPrice: '102',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out).toMatchObject({ ok: true, interval: '1m', recommendation: 'NEUTRAL' });
  });

  it('skips an interval with no configured triggers', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m')], // No when* sell triggers configured.
        [{ interval: '1m', signal: sig('STRONG_SELL') }],
      ),
      currentPrice: '102',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out.ok).toBe(false);
  });

  it('ignores a stale matching signal — sell side ignores expired regardless of ifExpires', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m', { whenStrongSell: true })],
        [{ interval: '1m', signal: sig('STRONG_SELL', 3 * 60_000) }], // 3 min old; window = 2 min
      ),
      currentPrice: '102',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out.ok).toBe(false);
  });

  it('exposes ageMs on a successful result so the audit layer can render signal age (iter54)', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m', { whenStrongSell: true })],
        [{ interval: '1m', signal: sig('STRONG_SELL', 90_000) }], // 90s old, window = 2 min
      ),
      currentPrice: '102',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out).toMatchObject({ ok: true, ageMs: 90_000 });
  });

  it('clamps future-dated signals to fresh (clock-skew tolerance)', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m', { whenStrongSell: true })],
        [{ interval: '1m', signal: { ...sig('STRONG_SELL'), receivedAtMs: NOW_MS + 5_000 } }],
      ),
      currentPrice: '102',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out.ok).toBe(true);
  });

  it('fires on the first matching interval when multiple are configured', () => {
    // Config carries a 5m row that does NOT trigger on the live BUY (no buy-
    // side toggles match) and a 1h row that DOES trigger on STRONG_SELL.
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('5m'), intervalRow('1h', { whenStrongSell: true })],
        [
          { interval: '5m', signal: sig('BUY') },
          { interval: '1h', signal: sig('STRONG_SELL') },
        ],
      ),
      currentPrice: '102',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out).toMatchObject({ ok: true, interval: '1h', recommendation: 'STRONG_SELL' });
  });

  it('returns ok=false when the matching interval has no signal yet', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv([intervalRow('1m', { whenStrongSell: true })], [{ interval: '1m', signal: null }]),
      currentPrice: '102',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out.ok).toBe(false);
  });

  it('returns ok=false when a decimal parse fails', () => {
    const out = evaluateTechnicalsForceSell({
      tv: tv(
        [intervalRow('1m', { whenStrongSell: true })],
        [{ interval: '1m', signal: sig('STRONG_SELL') }],
      ),
      currentPrice: 'not-a-number',
      avgEntryPrice: '100',
      triggerPrice: '105',
      nowMs: NOW_MS,
    });
    expect(out.ok).toBe(false);
  });

  // Min-profit floor: the force-sell may only fire above
  // avgEntryPrice × (1 + minProfitPercent/100), so a "win" smaller than the
  // round-trip fee never books. '0' / '' / absent / unparseable = no floor.
  const floorInput = (currentPrice: string, minProfitPercent?: string) => ({
    tv: tv(
      [intervalRow('1m', { whenStrongSell: true })],
      [{ interval: '1m', signal: sig('STRONG_SELL') }],
    ),
    currentPrice,
    avgEntryPrice: '100',
    triggerPrice: '105',
    nowMs: NOW_MS,
    minProfitPercent,
  });

  it('holds when profit is below the minProfitPercent floor', () => {
    // +0.2% (100.20) is below the 0.3% floor (100.30) → no force-sell.
    expect(evaluateTechnicalsForceSell(floorInput('100.20', '0.3')).ok).toBe(false);
  });

  it('fires when profit clears the minProfitPercent floor', () => {
    // +0.5% (100.50) is above the 0.3% floor → force-sell.
    expect(evaluateTechnicalsForceSell(floorInput('100.50', '0.3')).ok).toBe(true);
  });

  it('holds at exactly the floor (must clear it, not merely reach it)', () => {
    // 100.30 === 100 × 1.003; the guard is `price <= floor` → hold.
    expect(evaluateTechnicalsForceSell(floorInput('100.30', '0.3')).ok).toBe(false);
  });

  it('an explicit 0 floor keeps the any-profit behaviour', () => {
    expect(evaluateTechnicalsForceSell(floorInput('100.01', '0')).ok).toBe(true);
  });

  it('an empty-string floor is treated as no floor', () => {
    expect(evaluateTechnicalsForceSell(floorInput('100.01', '')).ok).toBe(true);
  });

  it('a negative floor is ignored (treated as no floor)', () => {
    expect(evaluateTechnicalsForceSell(floorInput('100.01', '-5')).ok).toBe(true);
  });

  it('a non-finite floor is ignored (treated as no floor)', () => {
    expect(evaluateTechnicalsForceSell(floorInput('100.01', 'Infinity')).ok).toBe(true);
  });

  it('an unparseable floor is ignored (treated as no floor)', () => {
    expect(evaluateTechnicalsForceSell(floorInput('100.01', 'oops')).ok).toBe(true);
  });
});

// Integration: the force-sell branch in `tick.ts` runs ahead of
// `evaluateSellGate`, so a matching TV signal that fires when the
// position is in profit and below the configured trigger emits a
// `tv-force-sell` Decision rather than waiting for the standard sell
// ladder. This locks the priority comment at tick.ts:268-270 (the
// force-sell evaluator wins when its guards pass) against a future
// re-order of checks in the sell branch.

import {
  trailingTrade,
  TTConfigSchema,
  TTBundleSchema,
  type TTState,
  type TTBundle,
  type TTConfig,
} from '../src/index.js';
import type { OpenOrder, TickInput } from '@app/strategy-core';

describe('trailingTrade tick — force-sell wins ahead of the standard sell ladder', () => {
  const sellCfg = (): TTConfig =>
    TTConfigSchema.parse({
      symbol: 'BTCUSDT',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '50' },
        avgEntryPriceRemoveThreshold: '0',
      },
      sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
      technicals: {
        useOnlyWithinMin: 2,
        ifExpires: 'do-not-buy',
        intervals: [
          {
            interval: '1m',
            whenStrongBuy: false,
            whenBuy: false,
            whenSell: false,
            whenStrongSell: true,
            whenNeutral: false,
          },
        ],
        // These cases assert the same-tick force-sell emit and the post-sell
        // state reset, so opt out of the new sub-1h confirm/cooldown defaults
        // (this 1m row would otherwise resolve a 1-minute confirm window).
        forceSellConfirmMinutes: 0,
        forceSellReentryCooldownMinutes: 0,
      },
    });

  const buildInput = (
    signal: NonNullable<TTBundle['technicals']['signals'][number]['signal']>,
  ): TickInput<TTConfig, TTState, TTBundle> => {
    const c = sellCfg();
    const heldState: TTState = {
      ...trailingTrade.initialState(c),
      avgEntryPrice: '100',
    };
    const bundle = TTBundleSchema.parse({
      technicals: {
        config: c.technicals,
        signals: [{ interval: '1m', signal }],
      },
      override: null,
    });
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
      state: heldState,
      market: {
        symbol: 'BTCUSDT',
        // Below the 105 trigger (lbp * 1.05), above the 97 stop-loss
        // (lbp * 0.97), above lbp (in profit). Only the force-sell
        // branch can fire on this configuration.
        currentPrice: '102.00',
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
      account: {
        balances: { BTC: { asset: 'BTC', free: new Decimal(1), locked: new Decimal(0) } },
        readable: true,
      },
      openOrders: [] as readonly OpenOrder[],
      bundle,
      limits: { weightUsed1m: 0, weightLimit1m: 1200, headroomBps: 10000 },
    };
  };

  it('emits a tv-force-sell Decision on a fresh STRONG_SELL with whenStrongSell configured', () => {
    const out = trailingTrade.tick(
      buildInput({
        symbol: 'BTCUSDT',
        recommendation: 'STRONG_SELL',
        maRecommendation: null,
        oscRecommendation: null,
        receivedAtMs: NOW_MS,
        indicators: null,
      }),
    );
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]).toMatchObject({
      type: 'place-order',
      intent: { side: 'SELL', reason: 'technicals-force-sell' },
      params: { type: 'MARKET' },
    });
    // State must reset just like the standard sell branch so the next
    // tick re-enters first-buy.
    expect(out.nextState.avgEntryPrice).toBeNull();
    expect(out.nextState.highSinceBuy).toBeNull();
    expect(out.nextState.currentGridTradeIndex).toBeNull();
    // Metric tag must name the symbol so the dashboard cardinality stays bounded.
    expect(out.metrics[0]).toMatchObject({
      name: 'tt_tv_force_sell_emit',
      tags: { symbol: 'BTCUSDT' },
    });
  });
});
