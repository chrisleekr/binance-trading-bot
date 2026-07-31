// Market-trend compute + handler contract. The regime classification and
// breadth math are pure (real @app/indicators sma/ema, no network); the
// handler test stubs the fetches and asserts the no-silent-failure skip and
// the snapshot shape the api route parses back.

import { describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { MarketTrendSchema } from '@app/contracts';
import type { Candle } from '@app/strategy-core';

import { classifyTrend, computeBreadth, MIN_CANDLES } from '../../src/crons/market-trend.js';
import { marketTrendHandler, type MarketTrendDeps } from '../../src/crons/market-trend.cron.js';

const candle = (close: number, i: number): Candle => ({
  openTimeMs: i,
  closeTimeMs: i + 1,
  open: String(close),
  high: String(close),
  low: String(close),
  close: String(close),
  volume: '1',
  isClosed: true,
});
const series = (closes: readonly number[]): Candle[] => closes.map((c, i) => candle(c, i));
const ramp = (n: number, start = 100): number[] => Array.from({ length: n }, (_, i) => start + i);

const BULL = series(ramp(160)); // 100..259 rising
const BEAR = series([...ramp(160)].reverse()); // 259..100 falling
// Rises for 149 bars then the last close drops below the 50-day SMA while the
// fast EMA stays above the slow EMA — the two signals disagree → neutral.
const NEUTRAL = series([...ramp(149), 150]);

const noopLogger = (): Logger =>
  ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }) as unknown as Logger;

describe('classifyTrend', () => {
  it('classifies a sustained uptrend as bull', () => {
    const r = classifyTrend('BTCUSDT', BULL);
    expect(r?.regime).toBe('bull');
    expect(r?.symbol).toBe('BTCUSDT');
    expect(r?.price).toBe('259');
  });

  it('classifies a sustained downtrend as bear', () => {
    expect(classifyTrend('ETHUSDT', BEAR)?.regime).toBe('bear');
  });

  it('classifies disagreeing signals as neutral', () => {
    expect(classifyTrend('BTCUSDT', NEUTRAL)?.regime).toBe('neutral');
  });

  it('returns null when the window is shorter than the slow-EMA warmup', () => {
    expect(classifyTrend('BTCUSDT', series(ramp(MIN_CANDLES - 1)))).toBeNull();
  });
});

describe('computeBreadth', () => {
  it('counts only the quote universe that closed green', () => {
    const r = computeBreadth([
      { symbol: 'BTCUSDT', priceChangePercent: '1.2' },
      { symbol: 'ETHUSDT', priceChangePercent: '-0.4' },
      { symbol: 'SOLUSDT', priceChangePercent: '0' },
      { symbol: 'FOOBTC', priceChangePercent: '5' }, // non-USDT, excluded
    ]);
    expect(r).toEqual({ upCount: 1, total: 3, percentUp: 33.3 });
  });

  it('returns null on an empty universe', () => {
    expect(computeBreadth([{ symbol: 'FOOBTC', priceChangePercent: '5' }])).toBeNull();
  });
});

describe('marketTrendHandler', () => {
  const baseDeps = (over: Partial<MarketTrendDeps> = {}): MarketTrendDeps => ({
    logger: noopLogger(),
    fetchDailyCandles: vi.fn(async (s: string) => (s === 'BTCUSDT' ? BULL : BEAR)),
    fetchTickers: vi.fn(async () => [
      { symbol: 'BTCUSDT', priceChangePercent: '1' },
      { symbol: 'ETHUSDT', priceChangePercent: '-1' },
    ]),
    writeSnapshot: vi.fn(async () => undefined),
    writeUsdPriceMap: vi.fn(async () => undefined),
    clock: { nowMs: () => 1_700_000_000_000 },
    ...over,
  });

  it('writes a schema-valid snapshot with both proxy symbols and breadth', async () => {
    const deps = baseDeps();
    await marketTrendHandler(deps)({} as Job);

    expect(deps.writeSnapshot).toHaveBeenCalledTimes(1);
    const json = (deps.writeSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const snap = MarketTrendSchema.parse(JSON.parse(json));
    expect(snap.computedAtMs).toBe(1_700_000_000_000);
    expect(snap.symbols.map((s) => s.regime)).toEqual(['bull', 'bear']);
    expect(snap.breadth).toEqual({ upCount: 1, total: 2, percentUp: 50 });
  });

  it('writes a one-symbol snapshot when only one proxy has enough candles', async () => {
    const deps = baseDeps({
      fetchDailyCandles: vi.fn(async (s: string) => (s === 'BTCUSDT' ? BULL : series(ramp(10)))),
    });
    await marketTrendHandler(deps)({} as Job);
    expect(deps.writeSnapshot).toHaveBeenCalledTimes(1);
    const json = (deps.writeSnapshot as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const snap = MarketTrendSchema.parse(JSON.parse(json));
    expect(snap.symbols.map((s) => s.symbol)).toEqual(['BTCUSDT']);
  });

  it('passes one cycle-deadline AbortSignal to both fetches so a stalled cycle can abort', async () => {
    const deps = baseDeps();
    await marketTrendHandler(deps)({} as Job);
    const candleArgs = (deps.fetchDailyCandles as ReturnType<typeof vi.fn>).mock.calls[0];
    const tickerArgs = (deps.fetchTickers as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(candleArgs?.[1]).toBeInstanceOf(AbortSignal);
    expect(tickerArgs?.[0]).toBeInstanceOf(AbortSignal);
    // Same signal across both fetches — one budget for the whole cycle.
    expect(tickerArgs?.[0]).toBe(candleArgs?.[1]);
  });

  it('does not write when no proxy symbol has enough candles', async () => {
    const deps = baseDeps({ fetchDailyCandles: vi.fn(async () => series(ramp(10))) });
    await marketTrendHandler(deps)({} as Job);
    expect(deps.writeSnapshot).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('does not write when breadth has no quote universe', async () => {
    const deps = baseDeps({ fetchTickers: vi.fn(async () => []) });
    await marketTrendHandler(deps)({} as Job);
    expect(deps.writeSnapshot).not.toHaveBeenCalled();
  });

  it('writes a usd-price-map keyed by symbol from each ticker lastPrice', async () => {
    // Phase B adds a `writeUsdPriceMap` seam wired to the global Redis key
    // `market-trend:usd-price-map`; the handler builds a symbol→lastPrice map
    // from the 24h tickers so the dashboard can value every held asset.
    const writeUsdPriceMap = vi.fn(async () => undefined);
    const deps = baseDeps({
      writeUsdPriceMap,
      fetchTickers: vi.fn(async () => [
        { symbol: 'BTCUSDT', priceChangePercent: '1', lastPrice: '70000' },
        { symbol: 'ETHUSDT', priceChangePercent: '-1', lastPrice: '2000' },
      ]),
    });

    await marketTrendHandler(deps)({} as Job);

    expect(writeUsdPriceMap).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (writeUsdPriceMap as ReturnType<typeof vi.fn>).mock.calls[0][0] as string,
    ) as { prices: Record<string, string> };
    expect(body.prices.ETHUSDT).toBe('2000');
    expect(body.prices.BTCUSDT).toBe('70000');
  });

  it('skips the usd-price-map write when no ticker carries a price', async () => {
    // Tickers with no `lastPrice` (halted/never-traded pairs report "0", which
    // the positivity filter also drops) yield an empty map; the empty-map guard
    // must skip the write so a transient priceless fetch never clobbers good
    // prices with an empty map.
    const writeUsdPriceMap = vi.fn(async () => undefined);
    const deps = baseDeps({
      writeUsdPriceMap,
      fetchTickers: vi.fn(async () => [
        { symbol: 'BTCUSDT', priceChangePercent: '1' },
        { symbol: 'ETHUSDT', priceChangePercent: '-1', lastPrice: '0' },
      ]),
    });
    await marketTrendHandler(deps)({} as Job);
    expect(writeUsdPriceMap).not.toHaveBeenCalled();
  });

  it('swallows fetch errors so the self-reschedule loop continues', async () => {
    const deps = baseDeps({
      fetchTickers: vi.fn(async () => {
        throw new Error('binance 503');
      }),
    });
    await expect(marketTrendHandler(deps)({} as Job)).resolves.toBeUndefined();
    expect(deps.writeSnapshot).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});
