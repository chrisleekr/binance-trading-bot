import { describe, expect, it } from 'vitest';
import { isHeldPosition, toFinite } from '../src/position.js';

describe('toFinite', () => {
  it('parses finite decimal strings', () => {
    expect(toFinite('1.5')).toBe(1.5);
    expect(toFinite('0')).toBe(0);
    expect(toFinite('-3')).toBe(-3);
  });

  it('returns null for absent, blank, whitespace, non-string, or malformed input', () => {
    expect(toFinite(null)).toBeNull();
    expect(toFinite(undefined)).toBeNull();
    expect(toFinite('')).toBeNull();
    expect(toFinite('   ')).toBeNull();
    expect(toFinite('NaN')).toBeNull();
    expect(toFinite('abc')).toBeNull();
    // A blank price must read as "no price", never Number('') === 0.
    expect(toFinite('')).not.toBe(0);
  });
});

describe('isHeldPosition', () => {
  it('is true only with an avg-entry-price and a strictly positive quantity', () => {
    expect(isHeldPosition('100', '0.5')).toBe(true);
  });

  it('is false when the quantity is zero, negative, blank, or missing', () => {
    expect(isHeldPosition('100', '0')).toBe(false);
    expect(isHeldPosition('100', '-1')).toBe(false);
    expect(isHeldPosition('100', '')).toBe(false);
    expect(isHeldPosition('100', null)).toBe(false);
    expect(isHeldPosition('100', undefined)).toBe(false);
  });

  it('is false when the avg-entry-price is missing even with a positive quantity', () => {
    // An entry-price-only or quantity-only ledger row is not a position.
    expect(isHeldPosition(null, '0.5')).toBe(false);
    expect(isHeldPosition(undefined, '0.5')).toBe(false);
  });
});
