import { describe, expect, it } from 'vitest';

import {
  BACKTEST_INTERVALS,
  candleIntervalMs,
  BINANCE_KLINE_INTERVALS,
  CANDLE_INTERVALS,
  isCandleInterval,
} from '../src/kline-intervals.js';

// The three derived sets pinned to their expected literal arrays. A drift in
// the spine (Binance adds/renames an interval) must break exactly one place —
// the spine — and these assertions catch a derivation that stopped matching.
describe('kline-interval derivations', () => {
  it('CANDLE_INTERVALS is the fixed spine plus 1M', () => {
    expect([...CANDLE_INTERVALS]).toEqual([
      '1m',
      '3m',
      '5m',
      '15m',
      '30m',
      '1h',
      '2h',
      '4h',
      '6h',
      '8h',
      '12h',
      '1d',
      '3d',
      '1w',
      '1M',
    ]);
  });

  it('BACKTEST_INTERVALS is the fixed spine (no 1M)', () => {
    expect([...BACKTEST_INTERVALS]).toEqual([
      '1m',
      '3m',
      '5m',
      '15m',
      '30m',
      '1h',
      '2h',
      '4h',
      '6h',
      '8h',
      '12h',
      '1d',
      '3d',
      '1w',
    ]);
  });

  it('BINANCE_KLINE_INTERVALS is 1s plus the spine plus 1M', () => {
    expect([...BINANCE_KLINE_INTERVALS]).toEqual([
      '1s',
      '1m',
      '3m',
      '5m',
      '15m',
      '30m',
      '1h',
      '2h',
      '4h',
      '6h',
      '8h',
      '12h',
      '1d',
      '3d',
      '1w',
      '1M',
    ]);
  });

  it('the set relationships hold: BACKTEST = CANDLE − {1M}, BINANCE = CANDLE ∪ {1s}', () => {
    expect([...BACKTEST_INTERVALS]).toEqual([...CANDLE_INTERVALS].filter((i) => i !== '1M'));
    expect([...BINANCE_KLINE_INTERVALS]).toEqual(['1s', ...CANDLE_INTERVALS]);
  });
});

describe('isCandleInterval', () => {
  it('accepts every member of CANDLE_INTERVALS', () => {
    for (const i of CANDLE_INTERVALS) expect(isCandleInterval(i)).toBe(true);
  });

  it('rejects 1s (Binance-only) and non-members', () => {
    expect(isCandleInterval('1s')).toBe(false);
    expect(isCandleInterval('2M')).toBe(false);
    expect(isCandleInterval('')).toBe(false);
    expect(isCandleInterval(60)).toBe(false);
    expect(isCandleInterval(null)).toBe(false);
    expect(isCandleInterval(undefined)).toBe(false);
  });
});

// Restated by hand, deliberately: a table derived from the implementation would agree with any value it happens to hold.
const PINNED_MS = [
  ['1m', 60_000],
  ['3m', 180_000],
  ['5m', 300_000],
  ['15m', 900_000],
  ['30m', 1_800_000],
  ['1h', 3_600_000],
  ['2h', 7_200_000],
  ['4h', 14_400_000],
  ['6h', 21_600_000],
  ['8h', 28_800_000],
  ['12h', 43_200_000],
  ['1d', 86_400_000],
  ['3d', 259_200_000],
  ['1w', 604_800_000],
] as const;

describe('candleIntervalMs', () => {
  it('maps every fixed-duration interval, and each is a positive whole number of ms', () => {
    for (const i of CANDLE_INTERVALS) {
      if (i === '1M') continue;
      const ms = candleIntervalMs(i);
      expect(ms).not.toBeNull();
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
    }
  });

  // Every duration by value, not just by shape. The tests around this one pin ordering, uniqueness and integrality, all of which a wrong-but-plausible number satisfies: `4h` set to 15_000_000 still sorts between `2h` and `6h`. The table just moved packages and gained a consumer that divides by it and names a config lever off the quotient, so a dropped digit would surface as an operator-facing sentence rather than as a failure.
  it.each(PINNED_MS)('%s spans %i ms', (interval, ms) => {
    expect(candleIntervalMs(interval)).toBe(ms);
  });

  it('covers every fixed-duration interval in the spine, so a new one cannot be added unpinned', () => {
    expect(PINNED_MS.map(([i]) => i)).toEqual(CANDLE_INTERVALS.filter((i) => i !== '1M'));
  });

  it('agrees with the interval order: each is strictly longer than the one before it', () => {
    // The tuple order is load-bearing elsewhere (rank comparisons index into it), so a table that disagreed with it would make two derivations of "coarser" contradict each other. Derived from the tuple rather than restated, so a new interval cannot be added to one and forgotten in the other.
    const spine = CANDLE_INTERVALS.filter((i) => i !== '1M').map((i) => candleIntervalMs(i));
    expect(spine).toEqual([...spine].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(new Set(spine).size).toBe(spine.length);
  });

  it('returns null for the calendar month, whose length is not constant', () => {
    expect(candleIntervalMs('1M')).toBeNull();
  });

  it('returns null for an unknown interval', () => {
    expect(candleIntervalMs('1s')).toBeNull();
    expect(candleIntervalMs('')).toBeNull();
    expect(candleIntervalMs('7h')).toBeNull();
  });

  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'returns null for the inherited member %s',
    (interval) => {
      // An object-literal lookup walks the prototype chain, and Object.freeze does not remove it, so these names would resolve to a function or to Object.prototype, defeat the `?? null`, and hand back a non-number the signature promises cannot happen. The caller then divides by it, gets NaN, and reads it as a mapped cadence. The sibling mapper in @app/binance is a Map for exactly this reason.
      expect(candleIntervalMs(interval)).toBeNull();
    },
  );
});
