import { describe, it, expect } from 'vitest';

import { bbPower } from '../../src/rating/bb-power.js';
import { loadCanonicalBtc1h, mkCloseWindow, mkOhlcvWindow } from './test-utils.js';

describe('bb-power', () => {
  it('returns null when window shorter than period', () => {
    expect(bbPower(mkCloseWindow(['1', '2']), 13)).toBeNull();
  });

  it('bull = high - EMA(close); bear = low - EMA(close)', () => {
    // Constant close → EMA = close. Single non-zero high/low offset on last bar
    // makes the math obvious.
    const bars = Array(13).fill({ o: '100', h: '100', l: '100', c: '100' });
    bars.push({ o: '100', h: '105', l: '97', c: '100' });
    const w = mkOhlcvWindow(bars);
    const out = bbPower(w, 13);
    expect(out).not.toBeNull();
    expect(out?.bull.toFixed(4)).toBe('5.0000');
    expect(out?.bear.toFixed(4)).toBe('-3.0000');
  });

  it('snapshots stable values on the canonical BTC fixture', () => {
    const out = bbPower(loadCanonicalBtc1h().candles, 13);
    expect({
      bull: out?.bull.toDecimalPlaces(2).toString(),
      bear: out?.bear.toDecimalPlaces(2).toString(),
    }).toMatchSnapshot();
  });
});
