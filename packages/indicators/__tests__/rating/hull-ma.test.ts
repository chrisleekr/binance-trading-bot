import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';

import type { Candle } from '@app/strategy-core';
import { hullMa } from '../../src/rating/hull-ma.js';
import { wma } from '../../src/rating/adapter.js';
import { loadCanonicalBtc1h, mkCloseWindow } from './test-utils.js';

/**
 * The pre-optimisation HullMA, verbatim: it materialises an inner WMA value for
 * EVERY prefix of the window (O(window²)) even though the outer WMA reads only
 * the trailing `sqrt(period)` of them. Kept as the oracle — the fast version
 * must agree with it bit-for-bit on every window, which is what makes the
 * rewrite safe for the golden replay fixtures.
 */
const hullMaReference = (w: readonly Candle[], period = 9): Decimal | null => {
  if (period <= 1 || w.length < period) return null;
  const halfPeriod = new Decimal(period).dividedBy(2).floor().toNumber();
  const sqrtFloor = new Decimal(period).sqrt().floor().toNumber();
  const sqrtPeriod = sqrtFloor < 1 ? 1 : sqrtFloor;
  const innerCandles: Candle[] = [];
  for (let i = period; i <= w.length; i++) {
    const slice = w.slice(0, i);
    const wHalf = wma(slice, halfPeriod);
    const wFull = wma(slice, period);
    if (wHalf === null || wFull === null) continue;
    const v = wHalf.times(2).minus(wFull);
    const last = slice[slice.length - 1];
    if (!last) continue;
    innerCandles.push({
      openTimeMs: last.openTimeMs,
      closeTimeMs: last.closeTimeMs,
      open: v.toString(),
      high: v.toString(),
      low: v.toString(),
      close: v.toString(),
      volume: '0',
      isClosed: true,
    });
  }
  if (innerCandles.length < sqrtPeriod) return null;
  return wma(innerCandles, sqrtPeriod);
};

describe('hull-ma — equivalence with the O(window²) reference', () => {
  const btc = loadCanonicalBtc1h().candles;

  it.each([9, 16, 25, 49])('matches the reference on the BTC fixture, period=%i', (period) => {
    const fast = hullMa(btc, period);
    const ref = hullMaReference(btc, period);
    expect(fast).not.toBeNull();
    expect(fast?.toString()).toBe(ref?.toString());
  });

  it.each([9, 10, 11, 12, 20, 51, 128, 250])(
    'matches the reference on every trailing window length, n=%i',
    (n) => {
      const w = btc.slice(btc.length - n);
      expect(hullMa(w, 9)?.toString() ?? null).toBe(hullMaReference(w, 9)?.toString() ?? null);
    },
  );

  it('agrees with the reference at the exact null boundary', () => {
    // period + sqrt(period) - 1 = 9 + 3 - 1 = 11 is the first length that rates.
    for (const n of [9, 10, 11]) {
      const w = btc.slice(btc.length - n);
      const fast = hullMa(w, 9);
      expect(fast?.toString() ?? null).toBe(hullMaReference(w, 9)?.toString() ?? null);
      expect(fast === null).toBe(n < 11);
    }
  });

  it('matches the reference on a sliding window, so replay ticks agree bar-for-bar', () => {
    for (let end = 60; end < 140; end += 7) {
      const w = btc.slice(end - 40, end);
      expect(hullMa(w, 9)?.toString() ?? null).toBe(hullMaReference(w, 9)?.toString() ?? null);
    }
  });
});

describe('hull-ma', () => {
  it('returns null when window shorter than period', () => {
    expect(hullMa(mkCloseWindow(['1', '2', '3']), 9)).toBeNull();
  });

  it('returns null for period <= 1', () => {
    expect(hullMa(mkCloseWindow(['1', '2', '3', '4', '5']), 1)).toBeNull();
  });

  it('returns null when the window equals the period (too few inner WMA points)', () => {
    // w.length === period passes the initial guard but yields fewer than
    // sqrt(period) inner candles, so the outer WMA cannot form → null.
    expect(hullMa(mkCloseWindow(Array(9).fill('100')), 9)).toBeNull();
  });

  it('produces a finite value on a constant series', () => {
    // Constant input → HMA equals the constant.
    const w = mkCloseWindow(Array(50).fill('100'));
    const out = hullMa(w, 9);
    expect(out).not.toBeNull();
    expect(out?.toFixed(4)).toBe('100.0000');
  });

  it('snapshots a stable value on the canonical BTC fixture', () => {
    const w = loadCanonicalBtc1h().candles;
    const out = hullMa(w, 9);
    expect(out?.toDecimalPlaces(4).toString()).toMatchSnapshot();
  });
});
