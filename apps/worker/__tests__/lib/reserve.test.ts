import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';

import { reserveAdjustedBalance } from '../../src/lib/reserve.js';

const d = (s: string): Decimal => new Decimal(s);

describe('reserveAdjustedBalance', () => {
  it('returns the balance unchanged when there is no reserve', () => {
    for (const reserve of [null, '', '0', '-5', 'abc', 'NaN'] as const) {
      const out = reserveAdjustedBalance(d('80'), d('10'), reserve);
      expect(out.free.eq(d('80'))).toBe(true);
      expect(out.locked.eq(d('10'))).toBe(true);
    }
  });

  it('drains the reserve from free first (whole reserve fits in free)', () => {
    // free 80, reserve 50 -> tradeable surplus 30 free, locked untouched.
    const out = reserveAdjustedBalance(d('80'), d('0'), '50');
    expect(out.free.eq(d('30'))).toBe(true);
    expect(out.locked.eq(d('0'))).toBe(true);
  });

  it('zeroes free when reserve equals the whole free holding', () => {
    // The first-enable case: operator holds exactly the reserve -> nothing tradeable.
    const out = reserveAdjustedBalance(d('50'), d('0'), '50');
    expect(out.free.eq(d('0'))).toBe(true);
    expect(out.locked.eq(d('0'))).toBe(true);
  });

  it('leaves locked intact when the reserve sits entirely in free', () => {
    // free 50 (all reserve), locked 30 is the bot's own surplus stop.
    const out = reserveAdjustedBalance(d('50'), d('30'), '50');
    expect(out.free.eq(d('0'))).toBe(true);
    expect(out.locked.eq(d('30'))).toBe(true);
  });

  it('spills the remainder of the reserve into locked once free is exhausted', () => {
    // free 20, locked 40, reserve 50 -> free 0, locked 10 (surplus = 10 total).
    const out = reserveAdjustedBalance(d('20'), d('40'), '50');
    expect(out.free.eq(d('0'))).toBe(true);
    expect(out.locked.eq(d('10'))).toBe(true);
  });

  it('never drives locked below zero when the reserve exceeds the whole wallet', () => {
    const out = reserveAdjustedBalance(d('5'), d('5'), '100');
    expect(out.free.eq(d('0'))).toBe(true);
    expect(out.locked.eq(d('0'))).toBe(true);
  });

  it('preserves decimal precision (no IEEE-754 drift)', () => {
    const out = reserveAdjustedBalance(d('0.30000001'), d('0'), '0.3');
    expect(out.free.eq(d('0.00000001'))).toBe(true);
  });
});
