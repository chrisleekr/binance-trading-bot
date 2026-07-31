import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';

import type { Candle } from '@app/strategy-core';
import { ultimateOscillator } from '../../src/rating/ultimate-osc.js';
import { loadCanonicalBtc1h, mkOhlcvWindow } from './test-utils.js';

/**
 * The pre-optimisation Ultimate Oscillator, verbatim: it builds a Decimal BP/TR
 * pair for every bar in the window even though only the trailing `long` pairs
 * are ever summed. Kept as the oracle for the trailing-slice rewrite.
 */
const ultimateOscillatorReference = (
  w: readonly Candle[],
  short = 7,
  mid = 14,
  long = 28,
): Decimal | null => {
  const ZERO = new Decimal(0);
  const sumOver = (arr: Decimal[], period: number, endExclusive: number): Decimal => {
    let acc = ZERO;
    for (let i = endExclusive - period; i < endExclusive; i++) acc = acc.plus(arr[i] ?? ZERO);
    return acc;
  };
  if (w.length < long + 1) return null;
  const bp: Decimal[] = [];
  const tr: Decimal[] = [];
  for (let i = 1; i < w.length; i++) {
    const c = w[i];
    const prev = w[i - 1];
    if (!c || !prev) continue;
    const high = new Decimal(c.high);
    const low = new Decimal(c.low);
    const close = new Decimal(c.close);
    const prevClose = new Decimal(prev.close);
    const trueLow = low.lessThan(prevClose) ? low : prevClose;
    const trueHigh = high.greaterThan(prevClose) ? high : prevClose;
    bp.push(close.minus(trueLow));
    tr.push(trueHigh.minus(trueLow));
  }
  if (bp.length < long) return null;
  const end = bp.length;
  const trShort = sumOver(tr, short, end);
  const trMid = sumOver(tr, mid, end);
  const trLong = sumOver(tr, long, end);
  if (trShort.isZero() || trMid.isZero() || trLong.isZero()) return null;
  const avgShort = sumOver(bp, short, end).dividedBy(trShort);
  const avgMid = sumOver(bp, mid, end).dividedBy(trMid);
  const avgLong = sumOver(bp, long, end).dividedBy(trLong);
  return avgShort.times(4).plus(avgMid.times(2)).plus(avgLong).times(100).dividedBy(7);
};

describe('ultimate oscillator — equivalence with the whole-window reference', () => {
  const btc = loadCanonicalBtc1h().candles;

  it.each([29, 30, 40, 100, 250])('matches the reference on a trailing window, n=%i', (n) => {
    const w = btc.slice(btc.length - n);
    expect(ultimateOscillator(w)?.toString() ?? null).toBe(
      ultimateOscillatorReference(w)?.toString() ?? null,
    );
  });

  it('agrees with the reference at the null boundary (long + 1 bars)', () => {
    for (const n of [27, 28, 29]) {
      const w = btc.slice(btc.length - n);
      const fast = ultimateOscillator(w);
      expect(fast?.toString() ?? null).toBe(ultimateOscillatorReference(w)?.toString() ?? null);
      expect(fast === null).toBe(n < 29);
    }
  });

  it('matches the reference on a sliding window and on custom periods', () => {
    for (let end = 60; end < 140; end += 11) {
      const w = btc.slice(end - 50, end);
      expect(ultimateOscillator(w)?.toString() ?? null).toBe(
        ultimateOscillatorReference(w)?.toString() ?? null,
      );
      expect(ultimateOscillator(w, 5, 10, 20)?.toString() ?? null).toBe(
        ultimateOscillatorReference(w, 5, 10, 20)?.toString() ?? null,
      );
    }
  });

  it('matches the reference on a flat (TR=0) window, returning null from both', () => {
    const flat = mkOhlcvWindow(Array(40).fill({ o: '5', h: '5', l: '5', c: '5' }));
    expect(ultimateOscillator(flat)).toBeNull();
    expect(ultimateOscillatorReference(flat)).toBeNull();
  });
});

describe('ultimate oscillator', () => {
  it('returns null when window shorter than long+1', () => {
    const w = mkOhlcvWindow(Array(10).fill({ o: '1', h: '1', l: '1', c: '1' }));
    expect(ultimateOscillator(w, 7, 14, 28)).toBeNull();
  });

  it('constant flat series returns NaN-safe behaviour (TR=0); guard against divide-by-zero', () => {
    // With perfectly flat prices, true range is 0 → division by zero. The
    // function returns a Decimal NaN/Infinity. We don't assert the exact value
    // — only that it does not crash.
    const w = mkOhlcvWindow(Array(40).fill({ o: '100', h: '100', l: '100', c: '100' }));
    expect(() => ultimateOscillator(w)).not.toThrow();
  });

  it('snapshots a stable value on the canonical BTC fixture', () => {
    const out = ultimateOscillator(loadCanonicalBtc1h().candles, 7, 14, 28);
    expect(out?.toDecimalPlaces(4).toString()).toMatchSnapshot();
  });
});
