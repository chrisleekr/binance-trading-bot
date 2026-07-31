// Behavioural gate for sell-side bull hold (slice 2). The SAME curated bull
// window is replayed twice — hold OFF vs hold ON (room=normal) — and the two
// reports are compared. On a confirmed daily bull, widening the trail must let a
// winning trade ride a routine mid-trend pullback that the default 2% trail
// would scalp, so the hold-on run takes FEWER sells and ends with a HIGHER
// captured return (mark-to-market final equity). Deterministic synthetic
// candles keep it CI-runnable (no live klines).

import { describe, expect, it } from 'vitest';
import type { Candle, CandleInterval } from '@app/strategy-core';
import { trailingTrade, type TTConfig } from '@app/strategy-trailing-trade';

import { runBacktest } from '../src/run.js';
import { OhlcvFillModel } from '../src/ohlcv-fill.js';
import { arrayMarketDataSource } from '../src/portfolio-source.js';
import { SYMBOL_INFO } from './_fixtures.js';

const HOUR = 3_600_000;
const DAY = 86_400_000;
// Trade candles start well after the daily regime candles so every "as of"
// daily window is strictly in the past (no lookahead).
const TRADE_BASE = DAY * 10;

// Confirmed daily bull: last-3 SMA = (50+150+200)/3 = 133; the last two closes
// (150, 200) are both above it. Dated on days 0-4, always before the trade window.
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

// A sustained 1h uptrend (100 → 140) that arms the 2% trailing stop and fills
// the 14-candle ATR window, then a single ~3.6% mid-trend pullback (140 → 135),
// then the trend resumes (135 → 150). The pullback breaches the 2% fixed trail
// (stop 137.2) but not the ATR-room trail (≈ 3 × ATR(6) below the 140 high).
const TREND_CLOSES = [
  100,
  103,
  106,
  109,
  112,
  115,
  118,
  121,
  124,
  127,
  130,
  133,
  136,
  139,
  140, // rise + high-water 140
  135, // mid-trend pullback
  138,
  142,
  146,
  150, // trend resumes
];

const tradeCandles = (): Candle[] => {
  let prevClose = TREND_CLOSES[0] ?? 100;
  return TREND_CLOSES.map((close, i) => {
    const open = i === 0 ? close : prevClose;
    prevClose = close;
    return {
      openTimeMs: TRADE_BASE + i * HOUR,
      closeTimeMs: TRADE_BASE + i * HOUR + HOUR - 1,
      open: String(open),
      high: String(close + 3), // constant ~6 true range ⇒ ATR(14) ≈ 6
      low: String(close - 3),
      close: String(close),
      volume: '10',
      isClosed: true,
    };
  });
};

const config = (holdEnabled: boolean): TTConfig =>
  trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '500' },
      avgEntryPriceRemoveThreshold: '0',
      firstBuyTriggerBasis: 'immediate',
      gridLevels: [{ triggerPercentage: '1', maxPurchaseAmount: '500' }],
    },
    // Stop-loss disabled so it never pre-empts; the trail is the only exit path
    // under test. trailingStopPercentage defaults to 0.98.
    sell: { enabled: true, stopLossPercentage: '', triggerPercentage: '1.05' },
    regime: {
      ma: 'sma',
      period: 3,
      confirmBars: 2,
      onBull: { hold: { enabled: holdEnabled, room: 'normal' } },
    },
    technicals: { intervals: [] },
  }) as TTConfig;

const runWindow = (holdEnabled: boolean) => {
  const candles = tradeCandles();
  const cfg = config(holdEnabled);
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) throw new Error('empty window');
  return runBacktest({
    strategy: trailingTrade,
    config: cfg,
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
    buildBundle: () => ({ technicals: { config: cfg.technicals, signals: [] }, override: null }),
  });
};

describe('trailingTrade — sell-side bull hold (backtest behaviour)', () => {
  it('holds through a mid-trend pullback: fewer sells and a higher captured return', async () => {
    const [off, on] = await Promise.all([runWindow(false), runWindow(true)]);

    const sells = (r: Awaited<ReturnType<typeof runWindow>>) =>
      r.trades.filter((t) => t.side === 'SELL').length;

    // Hold OFF scalps the pullback (the 2% trail fires); hold ON rides it.
    expect(sells(off)).toBeGreaterThan(0);
    expect(sells(on)).toBeLessThan(sells(off));

    // Riding the trend instead of scalping + re-entering captures more.
    expect(on.summary.totalReturnPct).toBeGreaterThan(off.summary.totalReturnPct);
  });

  it('is deterministic across two identical hold-on runs', async () => {
    const [a, b] = await Promise.all([runWindow(true), runWindow(true)]);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
