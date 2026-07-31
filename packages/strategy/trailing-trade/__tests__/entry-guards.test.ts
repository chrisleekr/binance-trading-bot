// Discovery "chase guard" (issue #473). A default-off entry guard: when the
// entry-hint bundle carries a 24h high and a max-distance-from-high percent, and
// the current price is within that distance of the 24h high, the strategy DEFERS
// the first entry (no place-order) and surfaces entryBlocker.reason='chase-guard'
// instead of chasing a coin that already ran. Phase A pins the desired behavior;
// the bundle fields and the guard do not exist yet, so this fails today.

import { describe, expect, it } from 'vitest';
import type { Candle, TickInput } from '@app/strategy-core';
import type { TechnicalsBundle } from '@app/contracts';

import { trailingTrade } from '../src/index.js';
import { chaseGuard, knifeGuard } from '../src/branches/entry-guards.js';
import {
  initialTTState,
  type TTBundle,
  type TTConfig,
  type TTEntryHintBundle,
  type TTState,
} from '../src/schema.js';

const NOW_MS = 1_700_000_000_000;

const intervalRow = (interval: string) => ({
  interval,
  whenStrongBuy: true,
  whenBuy: true,
  whenSell: false,
  whenStrongSell: false,
  whenNeutral: false,
  mode: 'block' as const,
});

const sig = (
  recommendation: 'BUY' | 'SELL' | 'STRONG_SELL' | 'NEUTRAL' | 'STRONG_BUY',
): TechnicalsBundle['signals'][number]['signal'] => ({
  symbol: 'BTCUSDT',
  recommendation,
  maRecommendation: null,
  oscRecommendation: null,
  receivedAtMs: NOW_MS,
  indicators: null,
});

const tv = (
  rows: ReturnType<typeof intervalRow>[],
  signals: { interval: string; signal: TechnicalsBundle['signals'][number]['signal'] }[],
): TechnicalsBundle => ({
  config: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: rows },
  signals,
});

// A fresh BUY read so the entry would otherwise pass both the normal gate and the
// enterOnAdd floor — this case isolates the chase guard, not a technicals veto.
const buyTv = tv([intervalRow('5m')], [{ interval: '5m', signal: sig('BUY') }]);

const candle = (px: string): Candle => ({
  openTimeMs: 0,
  closeTimeMs: 0,
  open: px,
  high: px,
  low: px,
  close: px,
  volume: '1',
  isClosed: true,
});

const FILTERS = {
  minNotional: '5',
  tickSize: '0.01',
  stepSize: '0.0001',
  minQty: '0.0001',
  maxQty: '1000000',
  minPrice: '0',
  maxPrice: '1000000',
};

// A discovery entry profile: immediate first-buy basis + a valid hard stop so the
// fail-closed discovery guardrail (#438) lets the entry arm. Without the chase
// guard this WOULD place a first buy.
const entryConfig = (): TTConfig =>
  trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
      firstBuyTriggerBasis: 'immediate',
      gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
    },
    sell: { enabled: true, stopLossPercentage: '0.9', triggerPercentage: '1.05' },
    technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [intervalRow('5m')] },
  }) as TTConfig;

// Full single-arg tick input (clock/rng live inside it), mirroring the Behavior E
// consumer harness in discovery-single-entry.test.ts. `entryHint` is built
// directly (not parsed through TTEntryHintBundleSchema, which would strip the new
// high24h / maxDistanceFrom24hHighPercent keys) so the test expresses the Phase B
// shape and fails on the missing guard, not on a parse error.
const tickInput = (
  entryHint: TTEntryHintBundle,
  currentPrice: string,
  candles: readonly Candle[] = [candle('100'), candle('100'), candle('100')],
  config: TTConfig = entryConfig(),
): TickInput<TTConfig, TTState, TTBundle> =>
  ({
    clock: { nowMs: () => NOW_MS },
    rng: { next: () => 0 },
    trigger: { kind: 'tick' },
    profile: { id: 'p1', userId: 'u1', binanceMode: 'test', status: 'running' },
    config,
    state: initialTTState(),
    market: {
      symbol: 'BTCUSDT',
      currentPrice,
      candlesByInterval: { '1h': candles },
      symbolInfo: {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        status: 'TRADING',
        filters: FILTERS,
      },
    },
    account: { balances: { USDT: { asset: 'USDT', free: '1000', locked: '0' } }, readable: true },
    openOrders: [],
    bundle: { technicals: buyTv, override: null, entryHint },
  }) as unknown as TickInput<TTConfig, TTState, TTBundle>;

describe('trailingTrade.tick — discovery chase guard (#473)', () => {
  it('defers a discovery entry with chase-guard when price is within maxDistanceFrom24hHighPercent of the 24h high', () => {
    // 24h high 100, max distance 3% ⇒ guard fires when price ≥ 100 × 0.97 = 97.
    // Price 98 is inside the band, so the entry must be deferred.
    const entryHint = {
      enterOnAdd: true,
      high24h: '100',
      maxDistanceFrom24hHighPercent: '3',
    } as unknown as TTEntryHintBundle;
    const out = trailingTrade.tick(tickInput(entryHint, '98'));

    expect(out.nextState.entryBlocker).not.toBeNull();
    expect(out.nextState.entryBlocker?.reason).toBe('chase-guard');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('surfaces chase-guard (not knife-guard) when both guards are armed and both would fire', () => {
    // Chase: high 100, max distance 3% ⇒ threshold 97, price 98 is inside the
    // band. Knife: closes 100 → 97 → 94 = 6% top-to-last >= 5%. Both fire; the
    // tick must surface chase-guard, pinning the chase-before-knife order at the
    // integration boundary.
    const entryHint = {
      enterOnAdd: true,
      high24h: '100',
      maxDistanceFrom24hHighPercent: '3',
      knifeCandles: 3,
      knifeDropPercent: '5',
    } as unknown as TTEntryHintBundle;
    const out = trailingTrade.tick(
      tickInput(entryHint, '98', [candle('100'), candle('97'), candle('94')]),
    );

    expect(out.nextState.entryBlocker?.reason).toBe('chase-guard');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('lets a discovery entry through when price is comfortably below the 24h high', () => {
    // 24h high 100, max distance 3% ⇒ threshold 97. Price 90 is below it, so the
    // chase guard does not fire and the entry places a first buy.
    const entryHint = {
      enterOnAdd: true,
      high24h: '100',
      maxDistanceFrom24hHighPercent: '3',
    } as unknown as TTEntryHintBundle;
    const out = trailingTrade.tick(tickInput(entryHint, '90'));

    expect(out.nextState.entryBlocker).toBeNull();
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(true);
  });

  it('defers a discovery entry with knife-guard when the recent window is falling past the drop', () => {
    // Closes 100 → 97 → 94: top-to-last decline = (100-94)/100 = 6%. With
    // knifeCandles 3 and knifeDropPercent 5 the guard fires. currentPrice 94 is
    // far below the (absent) chase high, so only the knife guard can bite.
    const entryHint = {
      enterOnAdd: true,
      knifeCandles: 3,
      knifeDropPercent: '5',
    } as unknown as TTEntryHintBundle;
    const out = trailingTrade.tick(
      tickInput(entryHint, '94', [candle('100'), candle('97'), candle('94')]),
    );

    expect(out.nextState.entryBlocker?.reason).toBe('knife-guard');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('lets a discovery entry through when a green first candle keeps the drop below the threshold', () => {
    // Closes 100 → 102 → 101: top is 102 (the green push), last 101, decline =
    // (102-101)/102 ≈ 0.98% < 5%, so the knife guard abstains and the entry buys.
    const entryHint = {
      enterOnAdd: true,
      knifeCandles: 3,
      knifeDropPercent: '5',
    } as unknown as TTEntryHintBundle;
    const out = trailingTrade.tick(
      tickInput(entryHint, '101', [candle('100'), candle('102'), candle('101')]),
    );

    expect(out.nextState.entryBlocker).toBeNull();
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(true);
  });
});

describe('trailingTrade.tick — guards on a non-enterOnAdd discovery entry (#486)', () => {
  // A discovery-managed symbol whose profile leaves enterOnAdd off (it still
  // passes the normal buy gate, not the relaxed floor) must STILL get the
  // anti-chase guards. The hint is armed with enterOnAdd:false but carries the
  // 24h high + guard params, so the guard fires the same as an enterOnAdd entry.
  it('defers a non-enterOnAdd discovery entry with chase-guard when price is within the band', () => {
    const entryHint = {
      enterOnAdd: false,
      high24h: '100',
      maxDistanceFrom24hHighPercent: '3',
    } as unknown as TTEntryHintBundle;
    const out = trailingTrade.tick(tickInput(entryHint, '98'));

    expect(out.nextState.entryBlocker?.reason).toBe('chase-guard');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('defers a non-enterOnAdd discovery entry with knife-guard when the window is falling', () => {
    const entryHint = {
      enterOnAdd: false,
      knifeCandles: 3,
      knifeDropPercent: '5',
    } as unknown as TTEntryHintBundle;
    const out = trailingTrade.tick(
      tickInput(entryHint, '94', [candle('100'), candle('97'), candle('94')]),
    );

    expect(out.nextState.entryBlocker?.reason).toBe('knife-guard');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });

  it('lets a non-enterOnAdd discovery entry through when both guards are off (default, replay-0)', () => {
    // The guard knobs absent ⇒ no veto. The entry takes the normal buy path and
    // places, exactly as it did before the guards were broadened.
    const entryHint = { enterOnAdd: false } as unknown as TTEntryHintBundle;
    const out = trailingTrade.tick(tickInput(entryHint, '98'));

    expect(out.nextState.entryBlocker).toBeNull();
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(true);
  });

  it('blocks the lowest-price dip-buy with knife-guard when the window is still falling (the WLD reversal case)', () => {
    // The exact gap #486 closes: a lowest-price-basis, non-enterOnAdd discovery
    // entry that has reached its trigger (price 94 ≤ window low 94 × level-0 1.0)
    // would buy the dip — but the window 100 → 97 → 94 is a 6% fall ≥ the 5% knife
    // drop, so the knife guard now defers instead of catching the falling knife.
    const lowestPriceConfig = trailingTrade.configSchema.parse({
      symbol: 'BTCUSDT',
      candleInterval: '1h',
      buy: {
        enabled: true,
        entrySizing: { mode: 'fixed', amount: '15' },
        avgEntryPriceRemoveThreshold: '0',
        firstBuyTriggerBasis: 'lowest-price',
        gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '15' }],
      },
      sell: { enabled: true, stopLossPercentage: '0.9', triggerPercentage: '1.05' },
      technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy', intervals: [intervalRow('5m')] },
    }) as TTConfig;
    const entryHint = {
      enterOnAdd: false,
      knifeCandles: 3,
      knifeDropPercent: '5',
    } as unknown as TTEntryHintBundle;
    const out = trailingTrade.tick(
      tickInput(entryHint, '94', [candle('100'), candle('97'), candle('94')], lowestPriceConfig),
    );

    expect(out.nextState.entryBlocker?.reason).toBe('knife-guard');
    expect(out.decisions.some((d) => d.type === 'place-order')).toBe(false);
  });
});

describe('chaseGuard (pure)', () => {
  it('returns null when high24h is absent', () => {
    expect(chaseGuard('98', undefined, '3')).toBeNull();
  });

  it("returns null when the max distance is the '0' off-sentinel", () => {
    expect(chaseGuard('98', '100', '0')).toBeNull();
  });

  it('returns null when the max distance is undefined', () => {
    expect(chaseGuard('98', '100', undefined)).toBeNull();
  });

  it('returns null when high24h is unparseable or non-positive', () => {
    expect(chaseGuard('98', 'not-a-number', '3')).toBeNull();
    expect(chaseGuard('98', '0', '3')).toBeNull();
  });

  it('returns null when the current price is unparseable', () => {
    expect(chaseGuard('not-a-number', '100', '3')).toBeNull();
  });

  it('vetoes at the boundary (price exactly at high × (1 - pct/100))', () => {
    // 100 × 0.97 = 97. A price of exactly 97 is within the band (>=), so veto.
    expect(chaseGuard('97', '100', '3')).toEqual({
      high24h: '100',
      currentPrice: '97',
      distancePct: '3',
    });
  });

  it('does not veto just below the boundary', () => {
    expect(chaseGuard('96.99', '100', '3')).toBeNull();
  });
});

describe('knifeGuard (pure)', () => {
  const c = (close: string): Candle => candle(close);

  it('returns null when knifeCandles is the 0 off-sentinel', () => {
    expect(knifeGuard([c('100'), c('90')], 0, '5')).toBeNull();
  });

  it('returns null when knifeCandles is undefined', () => {
    expect(knifeGuard([c('100'), c('90')], undefined, '5')).toBeNull();
  });

  it("returns null when knifeDropPercent is the '0' off-sentinel", () => {
    expect(knifeGuard([c('100'), c('90')], 2, '0')).toBeNull();
  });

  it('returns null when knifeDropPercent is undefined', () => {
    expect(knifeGuard([c('100'), c('90')], 2, undefined)).toBeNull();
  });

  it('returns null when there are not enough closed candles', () => {
    expect(knifeGuard([c('100')], 3, '5')).toBeNull();
  });

  it('vetoes when the top-to-last decline meets the drop threshold', () => {
    // Window 100 → 97 → 94, top 100, last 94 ⇒ 6% >= 5%.
    expect(knifeGuard([c('100'), c('97'), c('94')], 3, '5')).toEqual({
      dropPct: '6',
      candles: 3,
    });
  });

  it('measures the decline from the highest close in the window, not the first', () => {
    // First candle green: 100 → 110 → 99. Top is 110, last 99 ⇒ 10% >= 5%, veto.
    const veto = knifeGuard([c('100'), c('110'), c('99')], 3, '5');
    expect(veto?.candles).toBe(3);
    expect(veto?.dropPct).toBe('10');
  });

  it('abstains when the decline is below the drop threshold', () => {
    // 100 → 99 → 98, top 100, last 98 ⇒ 2% < 5%.
    expect(knifeGuard([c('100'), c('99'), c('98')], 3, '5')).toBeNull();
  });

  it('abstains on a flat-or-up window (decline <= 0)', () => {
    expect(knifeGuard([c('100'), c('101'), c('102')], 3, '5')).toBeNull();
  });

  it('returns null when every close in the window is unparseable', () => {
    expect(knifeGuard([c('x'), c('y')], 2, '5')).toBeNull();
  });

  it('returns null when every close in the window is non-positive (zero reference)', () => {
    // Last close 0 parses (lastClose ok) but every close is skipped as a max
    // reference, so maxClose stays null and the guard abstains (no divide-by-0).
    expect(knifeGuard([c('0'), c('0'), c('0')], 3, '5')).toBeNull();
  });

  it('skips a non-positive close but still measures from a valid earlier close', () => {
    // Window 100 → 0 → 94: the 0 is skipped as a max candidate, max is 100, last
    // 94 ⇒ 6% >= 5%, veto.
    expect(knifeGuard([c('100'), c('0'), c('94')], 3, '5')).toEqual({
      dropPct: '6',
      candles: 3,
    });
  });

  it('skips an unparseable close but still measures the rest of the window', () => {
    // The middle close is garbage and skipped; max is 100, last 94 ⇒ 6% >= 5%.
    expect(knifeGuard([c('100'), c('bad'), c('94')], 3, '5')).toEqual({
      dropPct: '6',
      candles: 3,
    });
  });

  it('returns null when the last close in the window is unparseable', () => {
    expect(knifeGuard([c('100'), c('97'), c('bad')], 3, '5')).toBeNull();
  });
});
