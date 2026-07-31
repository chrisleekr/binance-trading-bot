import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Decimal from 'decimal.js';
import type { Candle } from '@app/strategy-core';
import {
  lowestLow,
  highestHigh,
  ath,
  sma,
  ema,
  rsi,
  atr,
  triggerPrice,
  limitPrice,
  profit,
  pearsonCorrelation,
  stddev,
} from '../src/index.js';

const mkCandle = (open: string, high: string, low: string, close: string, t = 0): Candle => ({
  openTimeMs: t,
  closeTimeMs: t + 60_000,
  open,
  high,
  low,
  close,
  volume: '0',
  isClosed: true,
});

const mkWindow = (closes: readonly string[]): readonly Candle[] =>
  closes.map((c, i) => mkCandle(c, c, c, c, i * 60_000));

describe('range indicators', () => {
  it('lowestLow returns the minimum low across the window', () => {
    const w = [
      mkCandle('1', '2', '0.9', '1.1'),
      mkCandle('1', '3', '0.5', '1.2'),
      mkCandle('1', '4', '0.7', '1.3'),
    ];
    expect(lowestLow(w).toString()).toBe('0.5');
  });

  it('highestHigh returns the maximum high', () => {
    const w = [mkCandle('1', '2', '0.9', '1.1'), mkCandle('1', '3.5', '0.5', '1.2')];
    expect(highestHigh(w).toString()).toBe('3.5');
  });

  it('ath equals highestHigh', () => {
    const w = [mkCandle('1', '2', '0.9', '1.1'), mkCandle('1', '3.5', '0.5', '1.2')];
    expect(ath(w).toString()).toBe(highestHigh(w).toString());
  });

  it('throws on empty window', () => {
    expect(() => lowestLow([])).toThrow(/empty candle window/);
    expect(() => highestHigh([])).toThrow(/empty candle window/);
  });
});

describe('moving averages', () => {
  it('sma over the trailing period averages the closes', () => {
    const w = mkWindow(['1', '2', '3', '4', '5']);
    expect(sma(w, 3).toString()).toBe('4'); // (3+4+5)/3
  });

  it('sma rejects non-positive period', () => {
    expect(() => sma(mkWindow(['1', '2']), 0)).toThrow(/positive integer/);
    expect(() => sma(mkWindow(['1', '2']), -1)).toThrow(/positive integer/);
  });

  it('sma rejects window shorter than period', () => {
    expect(() => sma(mkWindow(['1', '2']), 5)).toThrow(/window length/);
  });

  it('ema converges toward the last close on a constant series', () => {
    const w = mkWindow(['10', '10', '10', '10', '10', '10']);
    expect(ema(w, 3).equals(new Decimal(10))).toBe(true);
  });

  it('ema responds faster than sma to a step change', () => {
    const w = mkWindow(['1', '1', '1', '1', '5']);
    const smaVal = sma(w, 3);
    const emaVal = ema(w, 3);
    expect(emaVal.greaterThan(smaVal)).toBe(true);
  });
});

describe('rsi', () => {
  it('returns 100 when there are no losses', () => {
    const w = mkWindow(['1', '2', '3', '4', '5', '6']);
    expect(rsi(w, 5).toString()).toBe('100');
  });

  it('returns a value between 0 and 100 inclusive', () => {
    const w = mkWindow(['10', '11', '10.5', '12', '11.5', '13', '12.5', '14']);
    const v = rsi(w, 5);
    expect(v.greaterThanOrEqualTo(0)).toBe(true);
    expect(v.lessThanOrEqualTo(100)).toBe(true);
  });

  it('rejects window shorter than period + 1', () => {
    expect(() => rsi(mkWindow(['1', '2', '3']), 5)).toThrow(/window length/);
  });
});

describe('atr', () => {
  it('is non-negative', () => {
    const w = [
      mkCandle('1', '2', '0.5', '1.5'),
      mkCandle('1.5', '3', '1', '2'),
      mkCandle('2', '4', '1.5', '2.5'),
      mkCandle('2.5', '5', '2', '3'),
    ];
    expect(atr(w, 3).greaterThanOrEqualTo(0)).toBe(true);
  });

  it('rejects window shorter than period + 1', () => {
    expect(() => atr(mkWindow(['1', '2', '3']), 5)).toThrow(/window length/);
  });
});

describe('composite signal helpers', () => {
  it('triggerPrice multiplies lowest by trigger pct', () => {
    expect(triggerPrice(new Decimal('100'), new Decimal('1.05')).toString()).toBe('105');
  });

  it('limitPrice multiplies price by limit pct', () => {
    expect(limitPrice(new Decimal('100'), new Decimal('0.99')).toString()).toBe('99');
  });

  it('profit returns (current - lastBuy) * qty', () => {
    expect(profit(new Decimal('100'), new Decimal('120'), new Decimal('2')).toString()).toBe('40');
    expect(profit(new Decimal('100'), new Decimal('80'), new Decimal('2')).toString()).toBe('-40');
  });
});

describe('property tests', () => {
  const finiteDecimal = (): fc.Arbitrary<string> =>
    fc
      .double({ min: 0.01, max: 1000, noNaN: true, noDefaultInfinity: true })
      .map((n) => n.toFixed(8));

  const candleArb = (): fc.Arbitrary<Candle> =>
    fc
      .tuple(finiteDecimal(), finiteDecimal(), finiteDecimal(), finiteDecimal())
      .map(([a, b, c, d]) => {
        const sorted = [a, b, c, d].map((s) => new Decimal(s)).sort((x, y) => x.comparedTo(y));
        const [lo, mid1, mid2, hi] = sorted as [Decimal, Decimal, Decimal, Decimal];
        return mkCandle(mid1.toString(), hi.toString(), lo.toString(), mid2.toString());
      });

  it('sma(period) is bounded by min and max close in the window', () => {
    fc.assert(
      fc.property(fc.array(candleArb(), { minLength: 1, maxLength: 30 }), (w) => {
        const period = w.length < 5 ? w.length : 5;
        const v = sma(w, period);
        const lastSlice = w.slice(w.length - period).map((c) => new Decimal(c.close));
        const lo = lastSlice.reduce((a, b) => (a.lessThan(b) ? a : b));
        const hi = lastSlice.reduce((a, b) => (a.greaterThan(b) ? a : b));
        expect(v.greaterThanOrEqualTo(lo)).toBe(true);
        expect(v.lessThanOrEqualTo(hi)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('lowestLow ≤ highestHigh on every non-empty window', () => {
    fc.assert(
      fc.property(fc.array(candleArb(), { minLength: 1, maxLength: 30 }), (w) => {
        expect(lowestLow(w).lessThanOrEqualTo(highestHigh(w))).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('ema on a constant window equals that constant', () => {
    fc.assert(
      fc.property(finiteDecimal(), fc.integer({ min: 2, max: 10 }), (val, period) => {
        const w = mkWindow(Array.from({ length: period + 5 }, () => val));
        expect(ema(w, period).equals(new Decimal(val))).toBe(true);
      }),
      { numRuns: 30 },
    );
  });
});

describe('stddev', () => {
  it('computes the population standard deviation over the trailing period', () => {
    // Classic example: [2,4,4,4,5,5,7,9] → mean 5, population stddev 2.
    const w = mkWindow(['2', '4', '4', '4', '5', '5', '7', '9']);
    expect(stddev(w, 8).toString()).toBe('2');
  });

  it('uses only the trailing `period` closes', () => {
    // The leading 100 is outside the trailing period-8 window; the tail
    // [2,4,4,4,5,5,7,9] → mean 5, population stddev 2.
    const w = mkWindow(['100', '2', '4', '4', '4', '5', '5', '7', '9']);
    expect(stddev(w, 8).toString()).toBe('2');
  });

  it('is 0 for a perfectly flat window', () => {
    expect(stddev(mkWindow(['5', '5', '5']), 3).toString()).toBe('0');
  });

  it('throws when the window is shorter than the period', () => {
    expect(() => stddev(mkWindow(['1', '2']), 5)).toThrow();
  });
});

describe('pearsonCorrelation', () => {
  const D = (xs: readonly number[]): Decimal[] => xs.map((x) => new Decimal(x));

  it('is +1 for a perfectly positively correlated series', () => {
    const a = D([1, 2, 3, 4]);
    const b = D([2, 4, 6, 8]); // exact linear scale
    expect(pearsonCorrelation(a, b)?.toFixed(6)).toBe('1.000000');
  });

  it('is -1 for a perfectly negatively correlated series', () => {
    const a = D([1, 2, 3, 4]);
    const b = D([8, 6, 4, 2]);
    expect(pearsonCorrelation(a, b)?.toFixed(6)).toBe('-1.000000');
  });

  it('is ~0 for an uncorrelated symmetric series', () => {
    const a = D([1, -1, 1, -1]);
    const b = D([1, 1, -1, -1]);
    expect(pearsonCorrelation(a, b)?.toFixed(6)).toBe('0.000000');
  });

  it('returns null when either series is constant (zero variance)', () => {
    expect(pearsonCorrelation(D([5, 5, 5]), D([1, 2, 3]))).toBeNull();
    expect(pearsonCorrelation(D([1, 2, 3]), D([7, 7, 7]))).toBeNull();
  });

  it('returns null for fewer than 2 points', () => {
    expect(pearsonCorrelation(D([1]), D([2]))).toBeNull();
    expect(pearsonCorrelation([], [])).toBeNull();
  });

  it('throws on a length mismatch', () => {
    expect(() => pearsonCorrelation(D([1, 2]), D([1, 2, 3]))).toThrow(/length mismatch/);
  });
});
