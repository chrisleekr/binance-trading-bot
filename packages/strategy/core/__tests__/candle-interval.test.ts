import { describe, expect, it } from 'vitest';
import { CANDLE_INTERVALS, isCandleInterval } from '../src/index.js';

describe('isCandleInterval', () => {
  it('accepts every member of the closed set', () => {
    for (const i of CANDLE_INTERVALS) expect(isCandleInterval(i)).toBe(true);
  });

  it('rejects out-of-range strings, wrong case, and non-strings', () => {
    for (const v of ['2m', '', '1H', '60', 'h1']) expect(isCandleInterval(v)).toBe(false);
    for (const v of [60, null, undefined, {}, ['1h']]) expect(isCandleInterval(v)).toBe(false);
  });
});
