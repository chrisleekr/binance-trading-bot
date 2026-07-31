import { describe, it, expect } from 'vitest';
import type { Candle, MarketSnapshot } from '@app/strategy-core';
import { evaluateMeanReversionGate } from '../src/mean-reversion-gate.js';
import { TTConfigSchema, type TTConfig } from '../src/schema.js';

const candle = (close: string, i: number): Candle => ({
  openTimeMs: i * 3_600_000,
  closeTimeMs: (i + 1) * 3_600_000,
  open: close,
  high: close,
  low: close,
  close,
  volume: '1',
  isClosed: true,
});

// closes [90,95,100,105,110] → mean 100, population stddev sqrt(50) ≈ 7.07.
const WINDOW: readonly Candle[] = ['90', '95', '100', '105', '110'].map(candle);

const cfg = (meanReversionGate: Record<string, unknown>): TTConfig =>
  TTConfigSchema.parse({
    symbol: 'BTCUSDT',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
      meanReversionGate,
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
  });

const market = (currentPrice: string, candles?: readonly Candle[]): MarketSnapshot => ({
  symbol: 'BTCUSDT',
  currentPrice,
  candlesByInterval: candles ? { '1h': candles } : {},
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
});

describe('evaluateMeanReversionGate', () => {
  it('passes when disabled (empty entryZScoreMax), without touching candles', () => {
    expect(evaluateMeanReversionGate(market('999999'), cfg({})).ok).toBe(true);
  });

  it('treats a config missing the gate block (pre-field row) as disabled', () => {
    // A config serialised before meanReversionGate existed reaches the gate
    // without the field; it must read as disabled, not throw.
    const base = cfg({});
    const legacy = {
      ...base,
      buy: { ...base.buy, meanReversionGate: undefined },
    } as unknown as TTConfig;
    expect(evaluateMeanReversionGate(market('999999'), legacy).ok).toBe(true);
  });

  it('passes a buy when price is far enough below the mean (z <= ceiling)', () => {
    // price 85 → z = (85-100)/7.07 ≈ -2.12, at/below the -1 ceiling.
    const r = evaluateMeanReversionGate(
      market('85', WINDOW),
      cfg({ entryZScoreMax: '-1', lookbackCandles: 5 }),
    );
    expect(r.ok).toBe(true);
  });

  it('vetoes a buy when price is above the ceiling (not a dip)', () => {
    // price 120 → z ≈ +2.83, well above the -1 ceiling.
    const r = evaluateMeanReversionGate(
      market('120', WINDOW),
      cfg({ entryZScoreMax: '-1', lookbackCandles: 5 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('indicator-mean-reversion');
  });

  it('vetoes as unavailable when the window is shorter than the lookback', () => {
    const r = evaluateMeanReversionGate(
      market('85', WINDOW.slice(0, 3)),
      cfg({ entryZScoreMax: '-1', lookbackCandles: 5 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('indicator-unavailable');
  });

  it('vetoes as unavailable when the candle interval is absent', () => {
    const r = evaluateMeanReversionGate(
      market('85'),
      cfg({ entryZScoreMax: '-1', lookbackCandles: 5 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('indicator-unavailable');
  });

  it('vetoes as unavailable on a flat window (stddev 0, z undefined)', () => {
    const flat = ['100', '100', '100', '100', '100'].map(candle);
    const r = evaluateMeanReversionGate(
      market('90', flat),
      cfg({ entryZScoreMax: '-1', lookbackCandles: 5 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('indicator-unavailable');
  });

  it('vetoes as unavailable when the current price cannot be parsed', () => {
    const r = evaluateMeanReversionGate(
      market('not-a-number', WINDOW),
      cfg({ entryZScoreMax: '-1', lookbackCandles: 5 }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('indicator-unavailable');
  });
});
