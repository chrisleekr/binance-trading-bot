import { describe, it, expect } from 'vitest';

import { ichimokuCloud } from '../../src/rating/ichimoku.js';
import { loadCanonicalBtc1h, mkOhlcvWindow } from './test-utils.js';

describe('ichimokuCloud', () => {
  it('requires the longest configured period', () => {
    const bars = Array.from({ length: 10 }, (_, i) => ({
      o: String(i + 1),
      h: String(i + 2),
      l: String(i),
      c: String(i + 1),
    }));
    expect(ichimokuCloud(mkOhlcvWindow(bars.slice(0, 9)), 6, 10, 4)).toBeNull();
    expect(ichimokuCloud(mkOhlcvWindow(bars), 6, 10, 4)).not.toBeNull();
  });

  it('requires 52 bars with the default leading-span-B period', () => {
    const bars = Array.from({ length: 52 }, (_, i) => ({
      o: String(i + 1),
      h: String(i + 2),
      l: String(i),
      c: String(i + 1),
    }));
    expect(ichimokuCloud(mkOhlcvWindow(bars.slice(0, 51)))).toBeNull();
    expect(ichimokuCloud(mkOhlcvWindow(bars))).not.toBeNull();
  });

  it('hand-computed Donchian midpoints for each line', () => {
    // 4 bars: highs 10, 12, 15, 11; lows 5, 4, 7, 6.
    const w = mkOhlcvWindow([
      { o: '8', h: '10', l: '5', c: '9' },
      { o: '9', h: '12', l: '4', c: '11' },
      { o: '11', h: '15', l: '7', c: '14' },
      { o: '14', h: '11', l: '6', c: '8' },
    ]);
    // base over all 4 bars: (max 15 + min 4) / 2 = 9.5
    // conversion over last 2 bars: (max 15 + min 6) / 2 = 10.5
    // leadB over all 4 bars: same window as base = 9.5
    // leadA = (conversion + base) / 2 = (10.5 + 9.5) / 2 = 10
    const cloud = ichimokuCloud(w, 2, 4, 4);
    expect(cloud?.base.toString()).toBe('9.5');
    expect(cloud?.conversion.toString()).toBe('10.5');
    expect(cloud?.leadB.toString()).toBe('9.5');
    expect(cloud?.leadA.toString()).toBe('10');
  });

  it('calculates leading spans from the current window', () => {
    const w = mkOhlcvWindow(
      Array.from({ length: 8 }, (_, i) => ({
        o: String(i + 1),
        h: String(i + 2),
        l: String(i),
        c: String(i + 1),
      })),
    );
    const cloud = ichimokuCloud(w, 2, 4, 4);
    expect(cloud?.conversion.toString()).toBe('7.5');
    expect(cloud?.base.toString()).toBe('6.5');
    expect(cloud?.leadA.toString()).toBe('7');
    expect(cloud?.leadB.toString()).toBe('6.5');
  });

  it('snapshots stable cloud lines on the canonical BTC fixture', () => {
    const cloud = ichimokuCloud(loadCanonicalBtc1h().candles);
    expect({
      conversion: cloud?.conversion.toDecimalPlaces(2).toString() ?? null,
      base: cloud?.base.toDecimalPlaces(2).toString() ?? null,
      leadA: cloud?.leadA.toDecimalPlaces(2).toString() ?? null,
      leadB: cloud?.leadB.toDecimalPlaces(2).toString() ?? null,
    }).toMatchSnapshot();
  });
});
