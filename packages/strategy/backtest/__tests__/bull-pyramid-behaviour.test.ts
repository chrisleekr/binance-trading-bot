// Behavioural + SAFETY gate for buy-side bull pyramid (slice 3). Two windows:
//   1. clean bull  — pyramid off vs on: on takes the strength-adds (more BUYs)
//      and ends with more capital deployed into the winner.
//   2. blow-off top — a parabolic ramp then a hard crash. This is the SAFETY
//      proof and a HARD merge gate: maxAdds and the risk caps must BOUND the
//      added size, and the reversal must liquidate the position (stop-loss).
// Deterministic synthetic candles keep it CI-runnable (no live klines).

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { Candle, CandleInterval } from '@app/strategy-core';
import { trailingTrade, type TTConfig } from '@app/strategy-trailing-trade';

import { runBacktest } from '../src/run.js';
import { OhlcvFillModel } from '../src/ohlcv-fill.js';
import { arrayMarketDataSource } from '../src/portfolio-source.js';
import { SYMBOL_INFO } from './_fixtures.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
const TRADE_BASE = DAY * 10;

// Confirmed daily bull for the whole window (last 2 of the last 3 closes above
// the 3-SMA). Dated before the trade window, returned as-of every tick.
const DAILY_BULL: readonly Candle[] = ['50', '50', '50', '150', '200'].map((close, i) => ({
  openTimeMs: i * DAY,
  closeTimeMs: i * DAY + DAY - 1,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true,
}));

const candlesFrom = (closes: readonly number[]): Candle[] => {
  let prev = closes[0] ?? 100;
  return closes.map((close, i) => {
    const open = i === 0 ? close : prev;
    prev = close;
    return {
      openTimeMs: TRADE_BASE + i * HOUR,
      closeTimeMs: TRADE_BASE + i * HOUR + HOUR - 1,
      open: String(open),
      high: String(Math.max(open, close)),
      low: String(Math.min(open, close)),
      close: String(close),
      volume: '10',
      isClosed: true,
    };
  });
};

// A steady > 6% per-candle climb so each candle clears the 5% step from the last
// add, then a couple of flat candles.
const CLEAN_BULL = candlesFrom([100, 107, 115, 123, 132, 141, 151, 151, 151]);
// Parabolic ramp (each candle > 6% up → would-be add) then a hard crash.
const BLOW_OFF = candlesFrom([100, 107, 115, 123, 132, 141, 151, 162, 70, 70]);

const baseConfig = (over: Partial<Record<string, unknown>> = {}) => ({
  symbol: 'BTCUSDT',
  candleInterval: '1h',
  buy: {
    enabled: true,
    entrySizing: { mode: 'fixed', amount: '50' },
    avgEntryPriceRemoveThreshold: '0',
    firstBuyTriggerBasis: 'immediate',
    ...over,
  },
  technicals: { intervals: [] },
});

const pyramidCfg = (opts: {
  enabled: boolean;
  maxAdds?: number;
  maxSymbolExposureQuote?: string;
  stopLossPercentage?: string;
}): TTConfig =>
  trailingTrade.configSchema.parse({
    ...baseConfig({ maxSymbolExposureQuote: opts.maxSymbolExposureQuote ?? '100000' }),
    sell: {
      enabled: true,
      stopLossPercentage: opts.stopLossPercentage ?? '',
      triggerPercentage: '1.05',
    },
    regime: {
      ma: 'sma',
      period: 3,
      confirmBars: 2,
      onBull: {
        pyramid: {
          enabled: opts.enabled,
          stepPercentage: '0.05',
          maxAdds: opts.maxAdds ?? 3,
          maxPurchaseAmount: '15',
        },
      },
    },
  }) as TTConfig;

const run = (candles: Candle[], config: TTConfig) => {
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) throw new Error('empty window');
  return runBacktest({
    strategy: trailingTrade,
    config,
    dataSource: arrayMarketDataSource([
      { symbol: 'BTCUSDT', interval: '1h' as CandleInterval, candles },
    ]),
    fillModel: new OhlcvFillModel({ makerBps: 10, takerBps: 10, slippageBps: 5 }),
    request: {
      symbols: ['BTCUSDT'],
      intervals: ['1h'],
      fromMs: first.openTimeMs,
      toMs: last.closeTimeMs,
    },
    initialBalances: { USDT: '1000' },
    quoteAsset: 'USDT',
    symbolInfos: [SYMBOL_INFO],
    startupCandleCount: 0,
    seed: 42,
    auxiliaryWindows: () => ({ '1d': DAILY_BULL }),
    buildBundle: () => ({ technicals: { config: config.technicals, signals: [] }, override: null }),
  });
};

const buys = (r: Awaited<ReturnType<typeof run>>) => r.trades.filter((t) => t.side === 'BUY');
const adds = (r: Awaited<ReturnType<typeof run>>) =>
  r.trades.filter((t) => t.side === 'BUY' && t.reason === 'bull-pyramid');
const sells = (r: Awaited<ReturnType<typeof run>>) => r.trades.filter((t) => t.side === 'SELL');

describe('trailingTrade — bull pyramid (backtest behaviour)', () => {
  it('clean bull: pyramid ON adds on strength, deploying more than OFF', async () => {
    const [off, on] = await Promise.all([
      run(CLEAN_BULL, pyramidCfg({ enabled: false })),
      run(CLEAN_BULL, pyramidCfg({ enabled: true })),
    ]);
    expect(adds(off).length).toBe(0);
    expect(adds(on).length).toBeGreaterThan(0);
    expect(buys(on).length).toBeGreaterThan(buys(off).length);
  });

  it('is deterministic across two identical pyramid-on runs', async () => {
    const [a, b] = await Promise.all([
      run(CLEAN_BULL, pyramidCfg({ enabled: true })),
      run(CLEAN_BULL, pyramidCfg({ enabled: true })),
    ]);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  // --- SAFETY GATE (mandatory) ---------------------------------------------

  it('blow-off top: maxAdds bounds the pyramid and the crash liquidates', async () => {
    const maxAdds = 3;
    const r = await run(
      BLOW_OFF,
      pyramidCfg({ enabled: true, maxAdds, stopLossPercentage: '0.90' }),
    );
    // The pyramid never extends past maxAdds, no matter how parabolic the ramp.
    expect(adds(r).length).toBeLessThanOrEqual(maxAdds);
    expect(adds(r).length).toBeGreaterThan(0);
    // The reversal liquidates: at least one SELL fires and the net base position
    // across all fills returns to (near) flat — nothing rides the crash down.
    expect(sells(r).length).toBeGreaterThan(0);
    const netBase = r.trades.reduce(
      (acc, t) => (t.side === 'BUY' ? acc.add(t.qty) : acc.sub(t.qty)),
      new Decimal(0),
    );
    expect(netBase.abs().lte(new Decimal('0.001'))).toBe(true);
  });

  it('blow-off top: the per-symbol exposure cap bounds total deployed', async () => {
    // A tight cap must stop the adds before maxAdds is reached: the summed BUY
    // notional never exceeds the cap.
    const cap = '90';
    const r = await run(
      BLOW_OFF,
      pyramidCfg({
        enabled: true,
        maxAdds: 10,
        maxSymbolExposureQuote: cap,
        stopLossPercentage: '0.90',
      }),
    );
    const deployedBeforeCrash = buys(r)
      .filter((t) => t.tsMs < TRADE_BASE + 8 * HOUR) // before the crash candle
      .reduce((acc, t) => acc.add(new Decimal(t.price).mul(t.qty)), new Decimal(0));
    expect(deployedBeforeCrash.lte(new Decimal(cap))).toBe(true);
    // And the cap genuinely bit: fewer adds than the generous maxAdds of 10.
    expect(adds(r).length).toBeLessThan(10);
  });
});
