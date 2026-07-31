import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { meetsMinNotional, roundToStep, roundToTick } from '../src/quantize.js';

describe('roundToStep', () => {
  it('floors to nearest multiple of step', () => {
    expect(roundToStep(new Decimal('0.12345'), new Decimal('0.001')).toString()).toBe('0.123');
  });

  it('returns zero when value is below step', () => {
    expect(roundToStep(new Decimal('0.0005'), new Decimal('0.01')).toString()).toBe('0');
  });

  it('preserves an exact multiple', () => {
    expect(roundToStep(new Decimal('10'), new Decimal('0.5')).toString()).toBe('10');
  });

  it('rejects non-positive step', () => {
    expect(() => roundToStep(new Decimal('1'), new Decimal('0'))).toThrow(/positive/);
    expect(() => roundToStep(new Decimal('1'), new Decimal('-0.1'))).toThrow(/positive/);
  });
});

describe('roundToTick', () => {
  it('floors price to tickSize', () => {
    expect(roundToTick(new Decimal('100.123'), new Decimal('0.01')).toString()).toBe('100.12');
  });

  it('rejects non-positive tickSize', () => {
    expect(() => roundToTick(new Decimal('100'), new Decimal('0'))).toThrow(/positive/);
  });
});

describe('meetsMinNotional', () => {
  it('returns true when notional equals threshold', () => {
    expect(meetsMinNotional(new Decimal('0.1'), new Decimal('100'), new Decimal('10'))).toBe(true);
  });

  it('returns true when notional exceeds threshold', () => {
    expect(meetsMinNotional(new Decimal('0.2'), new Decimal('100'), new Decimal('10'))).toBe(true);
  });

  it('returns false when notional is below threshold', () => {
    expect(meetsMinNotional(new Decimal('0.05'), new Decimal('100'), new Decimal('10'))).toBe(
      false,
    );
  });
});
