// resolvePrecision — covers the filterTickSize-first / derive-fallback split.
// formatChartPrice — the OHLC-legend price formatter.

import { describe, expect, it } from 'vitest';

import {
  formatChartPrice,
  isOhlcPoint,
  latestOhlc,
  resolvePrecision,
} from '../src/features/symbol/components/symbol-candle-chart.js';

const candle = (
  close: string,
): { time: string; open: string; high: string; low: string; close: string; volume: string } => ({
  time: '2026-05-10T12:00:00.000Z',
  open: close,
  high: close,
  low: close,
  close,
  volume: '0',
});

describe('resolvePrecision', () => {
  it('uses authoritative filterTickSize when supplied', () => {
    const out = resolvePrecision('0.00000001', [candle('50000.5')]);
    expect(out.precision).toBe(8);
    expect(out.minMove).toBe(0.00000001);
  });

  it('strips trailing zeros from the tickSize when deriving precision', () => {
    const out = resolvePrecision('0.01000000', [candle('50000.5')]);
    // Real tick increment is 0.01 — 2 meaningful decimals, not 8.
    expect(out.precision).toBe(2);
    expect(out.minMove).toBe(0.01);
  });

  it('falls back to derive when filterTickSize is null', () => {
    const out = resolvePrecision(null, [candle('50000.123456')]);
    expect(out.precision).toBe(6);
  });

  it('falls back to derive when filterTickSize is non-finite', () => {
    const out = resolvePrecision('not-a-number', [candle('50000.5')]);
    // derivePrecision sees 1 decimal, but the floor is 2.
    expect(out.precision).toBe(2);
  });
});

describe('formatChartPrice', () => {
  it('renders fixed precision with thousands grouping', () => {
    expect(formatChartPrice(78223.04, 2)).toBe('78,223.04');
  });

  it('pads to the requested precision', () => {
    expect(formatChartPrice(50000, 2)).toBe('50,000.00');
    expect(formatChartPrice(0.5, 8)).toBe('0.50000000');
  });

  it('renders whole numbers at zero precision', () => {
    expect(formatChartPrice(88407, 0)).toBe('88,407');
  });
});

describe('isOhlcPoint', () => {
  it('accepts a bar with four numeric OHLC fields', () => {
    expect(isOhlcPoint({ open: 1, high: 2, low: 0.5, close: 1.5 })).toBe(true);
  });

  it('rejects a line-series datum, a partial bar, and non-objects', () => {
    expect(isOhlcPoint({ value: 1 })).toBe(false);
    expect(isOhlcPoint({ open: 1, high: 2, low: 0.5 })).toBe(false);
    expect(isOhlcPoint({ open: '1', high: 2, low: 0.5, close: 1.5 })).toBe(false);
    expect(isOhlcPoint(null)).toBe(false);
    expect(isOhlcPoint(undefined)).toBe(false);
  });
});

describe('latestOhlc', () => {
  it('returns null for an empty candle window', () => {
    expect(latestOhlc([])).toBeNull();
  });

  it('returns the last candle as numbers', () => {
    expect(latestOhlc([candle('100.5'), candle('200.25')])).toEqual({
      open: 200.25,
      high: 200.25,
      low: 200.25,
      close: 200.25,
    });
  });
});
