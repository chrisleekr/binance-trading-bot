import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import {
  isFiniteDecimalString,
  isPlainDecimalString,
  parseDecimal,
  toFixedStep,
} from '../src/format.js';

describe('toFixedStep', () => {
  it('formats with the decimal places of the step', () => {
    expect(toFixedStep(new Decimal('0.123'), new Decimal('0.001'))).toBe('0.123');
    expect(toFixedStep(new Decimal('1'), new Decimal('0.01'))).toBe('1.00');
  });

  it('truncates trailing precision past the step', () => {
    expect(toFixedStep(new Decimal('0.12345'), new Decimal('0.01'))).toBe('0.12');
  });

  it('handles integer step (decimalPlaces=0)', () => {
    expect(toFixedStep(new Decimal('7'), new Decimal('1'))).toBe('7');
  });
});

describe('parseDecimal', () => {
  it('round-trips a finite decimal-string', () => {
    expect(parseDecimal('1.5').toString()).toBe('1.5');
  });

  it('throws on malformed input', () => {
    expect(() => parseDecimal('not-a-number')).toThrow();
  });
});

describe('isFiniteDecimalString', () => {
  it('returns true for finite decimal strings', () => {
    expect(isFiniteDecimalString('0')).toBe(true);
    expect(isFiniteDecimalString('1.234')).toBe(true);
    expect(isFiniteDecimalString('-5e2')).toBe(true);
  });

  it('returns false for non-finite values', () => {
    expect(isFiniteDecimalString('NaN')).toBe(false);
    expect(isFiniteDecimalString('Infinity')).toBe(false);
    expect(isFiniteDecimalString('-Infinity')).toBe(false);
  });

  it('returns false for malformed input', () => {
    expect(isFiniteDecimalString('abc')).toBe(false);
    expect(isFiniteDecimalString('')).toBe(false);
  });
});

describe('isPlainDecimalString', () => {
  it('accepts plain decimals: integer, fraction, bare-fraction, trailing-dot, signed', () => {
    for (const ok of ['0', '123', '1.5', '-1.5', '.5', '-.5', '12.', '0.00000000', '-0']) {
      expect(isPlainDecimalString(ok)).toBe(true);
    }
  });

  it('rejects anything the wire never legitimately produces', () => {
    for (const bad of [
      '1e5',
      '1E5',
      '1.5e-3',
      '0x1f',
      '0o17',
      '0b10',
      '1_000',
      '+1',
      'Infinity',
      '-Infinity',
      'NaN',
      '',
      ' 1',
      '1 ',
      'abc',
    ]) {
      expect(isPlainDecimalString(bad)).toBe(false);
    }
  });
});
