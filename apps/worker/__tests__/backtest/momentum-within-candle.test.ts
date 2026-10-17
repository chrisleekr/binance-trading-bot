import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';
import { OhlcvFillModel, arrayMarketDataSource, runBacktest } from '@app/strategy-backtest';
import { buildStrategyRegistry } from '@app/strategy-registry';

// Scope: proves momentum's REAL profit trail sells inside a daily candle when the engine replays it minute by minute, and holds through the same candle when it does not. The engine and runner tests use probe strategies; this is the one that ties the capability to the exit it exists for.

const DAY = 86_400_000;
const MIN = 60_000;
const SYMBOL_INFO = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '5',
    tickSize: '0.01',
    stepSize: '0.0001',
    minQty: '0.0001',
    maxQty: '1000000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
} as const;

const minuteBar = (t: number, from: number, to: number): Candle => ({
  openTimeMs: t,
  closeTimeMs: t + MIN - 1,
  open: from.toFixed(2),
  high: Math.max(from, to).toFixed(2),
  low: Math.min(from, to).toFixed(2),
  close: to.toFixed(2),
  volume: '1000',
  isClosed: true,
});

// One day of 1-minute bars walking linearly through `path` (one price per segment boundary).
function dayOfBars(day: number, path: readonly number[]): Candle[] {
  const bars: Candle[] = [];
  const segments = path.length - 1;
  for (let m = 0; m < 1440; m++) {
    const at = (i: number): number => {
      const pos = (i / 1440) * segments;
      const k = Math.min(segments - 1, Math.floor(pos));
      const a = path[k] ?? 0;
      const b = path[k + 1] ?? a;
      return a + (b - a) * (pos - k);
    };
    bars.push(minuteBar(day * DAY + m * MIN, at(m), at(m + 1)));
  }
  return bars;
}

const daily = (day: number, bars: readonly Candle[], flat?: number): Candle => {
  const opens = bars.map((b) => Number(b.open));
  const closes = bars.map((b) => Number(b.close));
  const highs = bars.map((b) => Number(b.high));
  const lows = bars.map((b) => Number(b.low));
  const price = (xs: number[], pick: (v: number[]) => number): string =>
    (bars.length > 0 ? pick(xs) : (flat ?? 0)).toFixed(2);
  return {
    openTimeMs: day * DAY,
    closeTimeMs: day * DAY + DAY - 1,
    open: price(opens, (v) => v[0] ?? 0),
    high: price(highs, (v) => Math.max(...v)),
    low: price(lows, (v) => Math.min(...v)),
    close: price(closes, (v) => v[v.length - 1] ?? 0),
    volume: '1000000',
    isClosed: true,
  };
};

// Fifteen days drifting down from 100 to 86 keep the fast EMA under the slow one; day 15 rallies to 95, which crosses it up on the close, so the buy fills on day 16's first minute. Day 16 runs to 105 (past the 8% activation) and falls back to 98 (more than 5% off 105), then day 17 sits at 98.
function series(): { coarse: Candle[]; detail: Candle[] } {
  const coarse: Candle[] = [];
  const detail: Candle[] = [];
  for (let d = 0; d < 15; d++) coarse.push(daily(d, [], 100 - d));
  const paths: Record<number, number[]> = { 15: [86, 95], 16: [95, 105, 98], 17: [98, 98] };
  for (const d of [15, 16, 17]) {
    const bars = dayOfBars(d, paths[d] ?? []);
    detail.push(...bars);
    coarse.push(daily(d, bars));
  }
  return { coarse, detail };
}

async function run(intraCandle: boolean) {
  const momentum = buildStrategyRegistry().get('momentum');
  if (!momentum) throw new Error('momentum not registered');
  const config = momentum.configSchema.parse({
    ...(momentum.defaultConfig as object),
    candleInterval: '1d',
    ema: { fast: 2, slow: 4 },
    entrySizing: { mode: 'fixed', amount: '100', percent: '' },
    trendFilter: { enabled: false },
    entryExtension: { enabled: false },
    profitTrail: { enabled: true, activationPct: '0.08', trailPct: '0.05', ratchetMinutes: 5 },
    trailingStopPct: '0.1',
  });
  const { coarse, detail } = series();
  return runBacktest({
    strategy: momentum as never,
    config,
    dataSource: arrayMarketDataSource([
      { symbol: 'BTCUSDT', interval: '1d', candles: coarse, detailCandles: detail },
    ]),
    fillModel: new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
    request: { symbols: ['BTCUSDT'], intervals: ['1d'], fromMs: 0, toMs: 18 * DAY },
    initialBalances: { USDT: '1000' },
    quoteAsset: 'USDT',
    symbolInfos: [SYMBOL_INFO],
    startupCandleCount: 5,
    ...(intraCandle ? { intraCandle: { interval: '1m' as const } } : {}),
  });
}

describe('momentum profit trail under within-candle ticking', () => {
  it('sells inside the day the trade ran up and fell back, above its entry', async () => {
    const report = await run(true);
    const buy = report.trades.find((t) => t.side === 'BUY');
    const sell = report.trades.find((t) => t.side === 'SELL');
    expect(buy).toBeDefined();
    expect(sell).toBeDefined();
    // Inside day 16, after the 105 peak and before its close.
    expect(sell?.tsMs).toBeGreaterThan(16 * DAY);
    expect(sell?.tsMs).toBeLessThan(17 * DAY - 1);
    // The trail's stop sits at the 105 peak × 0.95 = 99.75. Its limit (× 0.98) is below that, so the armed limit is marketable and fills at the stop itself (zero slippage and spread here), not at the limit near 97.75: a gain on the 95 entry that the hard stop alone (95 × 0.9) would have given back.
    expect(Number(sell?.price)).toBe(99.75);
    expect(Number(sell?.price)).toBeGreaterThan(Number(buy?.price));
  });

  it('holds through that day when the replay ticks once per candle', async () => {
    const report = await run(false);
    expect(report.trades.find((t) => t.side === 'BUY')).toBeDefined();
    const sellsOnDay16 = report.trades.filter(
      (t) => t.side === 'SELL' && t.tsMs >= 16 * DAY && t.tsMs < 17 * DAY,
    );
    expect(sellsOnDay16).toHaveLength(0);
  });
});
