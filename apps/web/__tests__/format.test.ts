// Decimal-string display formatters — apps/web/src/shared/lib/format.ts.

import { describe, expect, it } from 'vitest';

import {
  formatAmount,
  formatBalanceAmount,
  formatBalanceMoney,
  formatFixed2,
  formatMoneyAmount,
  formatPercent,
  formatPrice,
  formatSignedAmount,
  signOf,
} from '../src/shared/lib/format.js';

// `toLocaleString(undefined, …)` is locale-sensitive; these assertions assume
// an en-style locale (',' grouping, '.' decimal), which the CI runner uses.
describe('formatAmount', () => {
  it('adds thousands separators and drops trailing zeros', () => {
    expect(formatAmount('78267.09000000')).toBe('78,267.09');
    expect(formatAmount('1000')).toBe('1,000');
    expect(formatAmount('0.00019000')).toBe('0.00019');
  });

  it('caps the fraction at 8 digits', () => {
    expect(formatAmount('0.123456789')).toBe('0.12345679');
  });

  it('returns the input unchanged when it is not a finite number', () => {
    expect(formatAmount('not-a-number')).toBe('not-a-number');
    expect(formatAmount('Infinity')).toBe('Infinity');
  });

  it('accepts a number directly so component-computed values share the precision policy', () => {
    expect(formatAmount(78267.09)).toBe('78,267.09');
    expect(formatAmount(0.123456789)).toBe('0.12345679');
    expect(formatAmount(1000)).toBe('1,000');
    // A non-finite number stringifies rather than rendering a bare NaN token.
    expect(formatAmount(Number.NaN)).toBe('NaN');
  });

  it('treats the empty string as zero (Number("") === 0)', () => {
    expect(formatAmount('')).toBe('0');
  });
});

describe('signOf', () => {
  it('classifies positive, negative, and zero', () => {
    expect(signOf('12.5')).toBe('pos');
    expect(signOf('-0.01')).toBe('neg');
    expect(signOf('0')).toBe('zero');
  });

  it('treats null, undefined, and non-finite input as zero', () => {
    expect(signOf(null)).toBe('zero');
    expect(signOf(undefined)).toBe('zero');
    expect(signOf('xyz')).toBe('zero');
  });
});

describe('formatMoneyAmount', () => {
  it('renders a value at or above 1 at a fixed 2-digit fraction', () => {
    expect(formatMoneyAmount('13.15433931')).toBe('13.15');
    expect(formatMoneyAmount('1000')).toBe('1,000.00');
  });

  it('keeps precision on a sub-unit value so it does not round to 0.00', () => {
    expect(formatMoneyAmount('0.002')).toBe('0.002');
    expect(formatMoneyAmount('0')).toBe('0');
  });

  it('returns the input unchanged when it is not a finite number', () => {
    expect(formatMoneyAmount('not-a-number')).toBe('not-a-number');
  });
});

describe('formatBalanceMoney', () => {
  it('caps a quote-asset wallet at 2dp instead of the raw 8-digit string', () => {
    expect(formatBalanceMoney('29.15892558')).toBe('29.16');
    expect(formatBalanceMoney('1200.25')).toBe('1,200.25');
  });

  it('pads zero and whole values to 2dp so the locked column stays aligned', () => {
    expect(formatBalanceMoney('0')).toBe('0.00');
    expect(formatBalanceMoney('5')).toBe('5.00');
  });

  it('keeps a sub-unit quote (e.g. a BTC-quoted pair) from rounding to 0.00', () => {
    expect(formatBalanceMoney('0.00123')).toBe('0.00123');
  });

  it('locks the negative path the Math.abs guard implies', () => {
    expect(formatBalanceMoney('-29.15892558')).toBe('-29.16');
  });

  it('returns the input unchanged when it is not finite', () => {
    expect(formatBalanceMoney('n/a')).toBe('n/a');
  });
});

describe('formatPrice', () => {
  it('floors a value at or above 1 at a 2-digit fraction, matching live ticks', () => {
    // A round seed (`68000`) and a live tick (`76700.76`) must share the
    // same fraction precision so the column reads cleanly in the coin grid.
    expect(formatPrice('68000')).toBe('68,000.00');
    expect(formatPrice('76700.76')).toBe('76,700.76');
  });

  it('keeps precision on a sub-1 price so a small-quote pair does not round to 0', () => {
    expect(formatPrice('0.00012345')).toBe('0.00012345');
  });

  it('pins the >= 1 boundary — 0.99 takes the sub-1 branch, 1 takes the 2dp branch', () => {
    expect(formatPrice('0.99')).toBe('0.99');
    expect(formatPrice('1')).toBe('1.00');
  });
});

describe('formatSignedAmount', () => {
  it('prefixes a positive value with +, keeps the - on a negative', () => {
    expect(formatSignedAmount('1234.5')).toBe('+1,234.50');
    expect(formatSignedAmount('-1234.5')).toBe('-1,234.50');
  });

  it('rounds to a 2-digit money fraction', () => {
    expect(formatSignedAmount('13.15433931')).toBe('+13.15');
  });

  it('leaves zero unsigned', () => {
    expect(formatSignedAmount('0')).toBe('0');
  });

  it('returns a non-finite input unchanged', () => {
    expect(formatSignedAmount('not-a-number')).toBe('not-a-number');
  });
});

describe('formatBalanceAmount', () => {
  it('pads an integer balance to 2 decimals', () => {
    expect(formatBalanceAmount('1')).toBe('1.00');
  });

  it('pads a sub-1 balance to at least 4 decimals', () => {
    expect(formatBalanceAmount('0.5')).toBe('0.5000');
  });

  it('keeps existing precision up to 8 decimals on a sub-1 balance', () => {
    expect(formatBalanceAmount('0.12345678')).toBe('0.12345678');
  });

  it('caps a long fractional at 8 decimals on a >=1 balance', () => {
    expect(formatBalanceAmount('1.123456789')).toBe('1.12345679');
  });

  it('renders zero as 0.00', () => {
    expect(formatBalanceAmount('0')).toBe('0.00');
  });

  it('returns a non-finite input unchanged', () => {
    expect(formatBalanceAmount('not-a-number')).toBe('not-a-number');
  });
});

describe('formatFixed2', () => {
  it('renders at a fixed 2-digit fraction', () => {
    expect(formatFixed2(1.25)).toBe('1.25');
    expect(formatFixed2(-1.1)).toBe('-1.10');
    expect(formatFixed2(0)).toBe('0.00');
  });

  it('collapses negative zero to a plain 0.00', () => {
    // A tiny fee-only loss rounds to "-0.00" without the guard.
    expect(formatFixed2(-0.0001)).toBe('0.00');
    expect(formatFixed2(-0.004)).toBe('0.00');
  });

  it('keeps the sign once the magnitude rounds to 0.01 or more', () => {
    expect(formatFixed2(-0.005)).toBe('-0.01');
  });
});

describe('formatPercent', () => {
  it('appends a percent sign to the 2dp value', () => {
    expect(formatPercent(12.34)).toBe('12.34%');
    expect(formatPercent(-5.39)).toBe('-5.39%');
  });

  it('normalises negative zero', () => {
    expect(formatPercent(-0.0001)).toBe('0.00%');
  });

  it('prefixes + on strictly positive values only when sign is requested', () => {
    expect(formatPercent(12.34, { sign: true })).toBe('+12.34%');
    expect(formatPercent(-5.39, { sign: true })).toBe('-5.39%');
    expect(formatPercent(0, { sign: true })).toBe('0.00%');
    // A tiny negative that rounds to zero must not render as -0.00% or +0.00%.
    expect(formatPercent(-0.0001, { sign: true })).toBe('0.00%');
  });
});
