import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import type { Candle, SymbolInfo } from '@app/strategy-core';
import { asAccountId, asProfileId } from '@app/contracts';
import {
  buildMarketSnapshot,
  parseIndicatorSnapshot,
  readRawSnapshot,
  selectCurrentPrice,
} from '../../src/tick/snapshot-loader.js';

const candle = (close: string, closeTimeMs: number): Candle => ({
  openTimeMs: closeTimeMs - 60_000,
  closeTimeMs,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true,
});

const symbolInfo: SymbolInfo = {
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  status: 'TRADING',
  filters: {
    minNotional: '10',
    tickSize: '0.01',
    stepSize: '0.0001',
    minQty: '0.0001',
    maxQty: '1000',
    minPrice: '0.01',
    maxPrice: '1000000',
  },
};

// Shape IndicatorComputer writes to `indicators:<symbol>:<interval>`:
// the IndicatorSnapshot fields plus symbol/interval coordinates.
const bundle = {
  symbol: 'BTCUSDT',
  interval: '1h',
  windowSize: 200,
  lowestLow: '40000',
  highestHigh: '60000',
  sma20: '50000',
  ema20: '50500',
  rsi14: '55.5',
  lastCandleCloseTimeMs: 1_700_000_000_000,
};

/**
 * Key-aware fake ioredis pipeline: `.get(key)` records the key, `.exec()` returns
 * one `[err, val]` tuple per queued GET in order. Every slot is a clean cache
 * miss `[null, null]` EXCEPT any `disable-action` key, which returns an errored
 * slot `[Error, null]` — the failure mode C4 asserts must fail the whole read
 * closed (never a fail-open trade).
 */
const makeFailingDisableRedis = (): Redis => {
  const queued: string[] = [];
  const pipeline = {
    get(key: string) {
      queued.push(key);
      return pipeline;
    },
    async exec() {
      return queued.map((k) =>
        k.includes(':disable-action:')
          ? [new Error('disable-action slot errored'), null]
          : [null, null],
      );
    },
  };
  return { pipeline: () => pipeline } as unknown as Redis;
};

describe('readRawSnapshot fail-closed on the disable-action slot (#658)', () => {
  // C4: the per-symbol disable key is read on the SAME pipeline as the
  // kill-switch and inherits the per-slot fail-closed `grab()` semantics —
  // an errored reply for that slot throws the whole read, so a paused coin can
  // never fall through to a fail-open trade on a transient Redis error. The fake
  // errors that exact slot by key, independent of its cursor position.
  it('throws when the disable-action pipeline slot carries an error', async () => {
    await expect(
      readRawSnapshot(makeFailingDisableRedis(), {
        accountId: asAccountId('33333333-3333-4333-8333-333333333333'),
        profileId: asProfileId('22222222-2222-4222-8222-222222222222'),
        symbol: 'BTCUSDT',
        intervals: ['1h'],
        nowMs: 1_700_000_000_000,
      }),
    ).rejects.toThrow('disable-action slot errored');
  });
});

describe('parseIndicatorSnapshot', () => {
  it('returns undefined for a null or empty payload', () => {
    expect(parseIndicatorSnapshot(null)).toBeUndefined();
    expect(parseIndicatorSnapshot('')).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(parseIndicatorSnapshot('{not json')).toBeUndefined();
  });

  it('returns undefined when a required field is missing or mistyped', () => {
    expect(parseIndicatorSnapshot(JSON.stringify({ windowSize: 1 }))).toBeUndefined();
    expect(parseIndicatorSnapshot(JSON.stringify({ ...bundle, lowestLow: 123 }))).toBeUndefined();
  });

  it('extracts the snapshot subset, dropping symbol and interval', () => {
    expect(parseIndicatorSnapshot(JSON.stringify(bundle))).toEqual({
      windowSize: 200,
      lowestLow: '40000',
      highestHigh: '60000',
      sma20: '50000',
      ema20: '50500',
      rsi14: '55.5',
      lastCandleCloseTimeMs: 1_700_000_000_000,
    });
  });

  it('coerces absent sma/ema/rsi values to null', () => {
    const snap = parseIndicatorSnapshot(
      JSON.stringify({ ...bundle, sma20: null, ema20: undefined, rsi14: 5 }),
    );
    expect(snap?.sma20).toBeNull();
    expect(snap?.ema20).toBeNull();
    expect(snap?.rsi14).toBeNull();
  });
});

describe('selectCurrentPrice', () => {
  it('returns 0 when no candle is available', () => {
    expect(selectCurrentPrice({})).toBe('0');
    expect(selectCurrentPrice({ '1h': [] })).toBe('0');
  });

  it('picks the freshest candle by closeTimeMs across intervals', () => {
    // The 1m candle is fresher than the 1h candle but appears in a later
    // map key, so insertion order would pick the stale 1h close.
    const price = selectCurrentPrice({
      '1h': [candle('50000', 1_700_000_000_000)],
      '1m': [candle('50250', 1_700_000_030_000)],
    });
    expect(price).toBe('50250');
  });

  it('prefers the fresher 1m close over a stale 5m close (stop-loss latency)', () => {
    // The 5m trading-interval candle closed at T; a 1m candle closed later in
    // the same 5m window. currentPrice must track the 1m close so a stop fires
    // within the minute instead of waiting for the 5m candle to close.
    const fiveMinClose = 1_700_000_000_000;
    const price = selectCurrentPrice({
      '5m': [candle('50000', fiveMinClose)],
      '1m': [candle('48000', fiveMinClose + 120_000)],
    });
    expect(price).toBe('48000');
  });
});

describe('buildMarketSnapshot', () => {
  it('derives currentPrice from the freshest candle and carries the indicator map', () => {
    const snap = parseIndicatorSnapshot(JSON.stringify(bundle));
    if (snap === undefined) throw new Error('fixture failed to parse');
    const market = buildMarketSnapshot(
      'BTCUSDT',
      symbolInfo,
      { '1h': [candle('50000', 1_700_000_000_000)] },
      { '1h': snap },
    );
    expect(market.currentPrice).toBe('50000');
    expect(market.indicatorsByInterval?.['1h']).toEqual(snap);
  });

  it('falls back to 0 currentPrice and accepts an empty indicator map', () => {
    const market = buildMarketSnapshot('BTCUSDT', symbolInfo, {}, {});
    expect(market.currentPrice).toBe('0');
    expect(market.indicatorsByInterval).toEqual({});
  });

  it('overrides currentPrice with the live price when present, leaving candle windows intact', () => {
    const candles = { '1h': [candle('50000', 1_700_000_000_000)] };
    const market = buildMarketSnapshot('BTCUSDT', symbolInfo, candles, {}, '50250');
    // The live price (the mini-ticker that fired the tick) wins over the
    // freshest closed candle's 50000 close — so a stop reacts to ~now, not ≤60s ago.
    expect(market.currentPrice).toBe('50250');
    // Candle windows (which feed indicators) are untouched by the override.
    expect(market.candlesByInterval['1h']).toBe(candles['1h']);
  });

  it('falls back to the closed-candle price when no live price is given (replay-safe)', () => {
    const market = buildMarketSnapshot(
      'BTCUSDT',
      symbolInfo,
      { '1h': [candle('50000', 1_700_000_000_000)] },
      {},
      undefined,
    );
    expect(market.currentPrice).toBe('50000');
  });
});
