import { describe, expect, it } from 'vitest';

import {
  BACKTEST_INTERVALS,
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
