import type { Candle } from '@app/strategy-core';
import type { DiscoveryConfig, DiscoveryTicker } from '../src/types.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * A balanced base config; individual tests override the field under exercise.
 * The rank band is inert here (top 100%, skip nothing) so the cross-sectional
 * filter never silently rejects a fixture built for a one- or two-symbol
 * universe; `run.test.ts` and `filters.test.ts` arm it explicitly.
 */
export const baseConfig: DiscoveryConfig = {
  quoteAsset: 'USDT',
  blacklist: [],
  min24hPairVolumeUsd: '10000000',
  min24hAssetVolumeUsd: '10000000',
  maxSpreadRatio: '0.003',
  changeMinPercent: '5',
  rankTopPercent: 100,
  rankExcludeTopPercent: 0,
  minAgeDays: 30,
  maxAutoSymbols: 5,
  minHoldMinutes: 120,
  marketBreadthMinPercent: '0',
  trendConfirm: {
    adxPeriod: 14,
    adxMin: '25',
    emaPeriod: 20,
    volSmaPeriod: 20,
    volMultiple: '1.5',
  },
};

export const cfg = (over: Partial<DiscoveryConfig> = {}): DiscoveryConfig => ({
  ...baseConfig,
  ...over,
  trendConfirm: { ...baseConfig.trendConfirm, ...(over.trendConfirm ?? {}) },
});

/** A ticker that passes every ticker-stage filter under baseConfig; override to fail one. */
export const ticker = (over: Partial<DiscoveryTicker> = {}): DiscoveryTicker => ({
  symbol: 'AAAUSDT',
  quoteAsset: 'USDT',
  priceChangePercent: '12',
  quoteVolume: '50000000',
  // Under a USDT quote the pair IS the coin's USD market, so both volumes agree.
  pairVolumeUsd: '50000000',
  assetVolumeUsd: '50000000',
  lastPrice: '100',
  bidPrice: '100',
  askPrice: '100.1',
  ...over,
});

/**
 * A quote universe of `n` distinct symbols with strictly descending 24h gains,
 * for exercising the cross-sectional rank band (which needs at least
 * `MIN_UNIVERSE_FOR_RANK` members to engage). Symbol `i` (0-based) has rank
 * `i + 1`, so the biggest gainer is `S00...`.
 */
export const rankUniverse = (n: number, over: Partial<DiscoveryTicker> = {}): DiscoveryTicker[] =>
  Array.from({ length: n }, (_, i) =>
    ticker({
      symbol: `S${String(i).padStart(2, '0')}USDT`,
      priceChangePercent: String(n - i),
      ...over,
    }),
  );

export const candle = (over: Partial<Candle> = {}): Candle => ({
  openTimeMs: 0,
  closeTimeMs: HOUR_MS,
  open: '100',
  high: '101',
  low: '99',
  close: '100',
  volume: '10',
  isClosed: true,
  ...over,
});

/**
 * A strong, steady hourly uptrend ending `nowMs` ago, with a closing volume
 * spike. Steep enough that ADX clears 25 and the last close sits above EMA20.
 * `firstOpenMs` controls age (oldest candle time).
 */
export const uptrend = (n: number, firstOpenMs: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const base = 100 + i * 4;
    return candle({
      openTimeMs: firstOpenMs + i * HOUR_MS,
      closeTimeMs: firstOpenMs + (i + 1) * HOUR_MS,
      open: String(base),
      high: String(base + 3),
      low: String(base - 1),
      close: String(base + 2),
      volume: i === n - 1 ? '1000' : '10',
    });
  });
