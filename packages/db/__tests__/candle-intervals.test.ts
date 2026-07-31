import { describe, expect, it } from 'vitest';
import { computeMissingRanges, intervalToMs } from '../src/candle-intervals.js';

describe('intervalToMs', () => {
  it('maps fixed-duration intervals to their span', () => {
    expect(intervalToMs('1m')).toBe(60_000);
    expect(intervalToMs('5m')).toBe(300_000);
    expect(intervalToMs('1h')).toBe(3_600_000);
    expect(intervalToMs('1d')).toBe(86_400_000);
    expect(intervalToMs('1w')).toBe(604_800_000);
  });

  it('throws on a non-fixed-duration or unknown interval', () => {
    expect(() => intervalToMs('1M')).toThrow(/unsupported candle interval/);
    expect(() => intervalToMs('2d')).toThrow(/unsupported candle interval/);
    expect(() => intervalToMs('')).toThrow(/unsupported candle interval/);
  });
});

describe('computeMissingRanges', () => {
  const MIN = 60_000;

  it('returns the whole grid when nothing is present', () => {
    // boundaries 0,60k,120k,180k,240k,300k all missing → one contiguous run
    expect(computeMissingRanges([], 0, 300_000, MIN)).toEqual([{ fromMs: 0, toMs: 300_000 }]);
  });

  it('returns [] when every boundary is present', () => {
    const present = [0, 60_000, 120_000, 180_000, 240_000, 300_000];
    expect(computeMissingRanges(present, 0, 300_000, MIN)).toEqual([]);
  });

  it('splits into runs around present candles', () => {
    expect(computeMissingRanges([60_000, 180_000], 0, 300_000, MIN)).toEqual([
      { fromMs: 0, toMs: 0 },
      { fromMs: 120_000, toMs: 120_000 },
      { fromMs: 240_000, toMs: 300_000 },
    ]);
  });

  it('aligns the first boundary up when fromMs falls mid-candle', () => {
    // fromMs 30k rounds up to 60k; 0 is below the window and ignored
    expect(computeMissingRanges([], 30_000, 180_000, MIN)).toEqual([
      { fromMs: 60_000, toMs: 180_000 },
    ]);
  });

  it('returns [] for an empty or inverted window', () => {
    expect(computeMissingRanges([], 300_000, 0, MIN)).toEqual([]);
    expect(computeMissingRanges([], 100, 100, MIN)).toEqual([]); // no boundary in (100,100)
  });

  it('returns [] when the first aligned boundary is past toMs', () => {
    // window [10, 50] contains no 60k-multiple boundary
    expect(computeMissingRanges([], 10, 50, MIN)).toEqual([]);
  });

  it('rejects a non-positive interval', () => {
    expect(() => computeMissingRanges([], 0, 60_000, 0)).toThrow(/intervalMs must be positive/);
  });
});
