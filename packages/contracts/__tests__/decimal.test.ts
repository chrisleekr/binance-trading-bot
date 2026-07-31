import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decimalMul, decimalString, DecimalString, PositiveDecimalString } from '../src/decimal.js';

const ok = (schema: z.ZodType<string>, value: string) =>
  expect(schema.safeParse(value).success).toBe(true);
const bad = (schema: z.ZodType<string>, value: string) =>
  expect(schema.safeParse(value).success).toBe(false);

describe('DecimalString / PositiveDecimalString', () => {
  it('accepts finite decimal strings and rejects NaN/Infinity', () => {
    ok(DecimalString, '1.5');
    ok(DecimalString, '-3');
    ok(DecimalString, '0');
    bad(DecimalString, 'NaN');
    bad(DecimalString, 'Infinity');
    bad(DecimalString, 'abc');
  });

  it('PositiveDecimalString rejects zero and negatives', () => {
    ok(PositiveDecimalString, '0.0001');
    bad(PositiveDecimalString, '0');
    bad(PositiveDecimalString, '-1');
  });

  it('PositiveDecimalString safeParse returns a failure (never throws) on a non-numeric string', () => {
    // zod runs every refine even after `isWellFormed` fails, so the positivity
    // refine still executes on garbage; it must not let a DecimalError escape
    // safeParse (which would 500 the API / dead-button the UI).
    expect(() => PositiveDecimalString.safeParse('abc')).not.toThrow();
    bad(PositiveDecimalString, 'abc');
    bad(PositiveDecimalString, '1.2.3');
  });
});

describe('decimalMul', () => {
  it('multiplies two decimal-strings to a canonical decimal-string', () => {
    expect(decimalMul('2', '3')).toBe('6');
    expect(decimalMul('0.028', '100')).toBe('2.8');
    // Canonicalises scale-padded numeric(38,18) reads from Postgres.
    expect(decimalMul('2.000000000000000000', '3.000000000000000000')).toBe('6');
  });

  it('keeps full precision (no IEEE-754 rounding)', () => {
    expect(decimalMul('0.1', '0.2')).toBe('0.02');
  });
});

describe('decimalString', () => {
  it('enforces gt and rejects non-finite', () => {
    const s = decimalString('must be a positive decimal', { gt: 0 });
    ok(s, '0.5');
    ok(s, '1000000');
    bad(s, '0');
    bad(s, '-1');
    bad(s, '');
    bad(s, 'NaN');
    bad(s, 'not-a-number');
  });

  it('honours allowEmpty without admitting other blanks', () => {
    const s = decimalString('empty or >= 1', { gte: 1, allowEmpty: true });
    ok(s, '');
    ok(s, '1');
    ok(s, '2.5');
    bad(s, '0.99');
    bad(s, '0');
  });

  it('honours allowZeroString as a disabled sentinel distinct from a real zero bound', () => {
    const s = decimalString("empty, '0', or in (0, 1]", {
      gt: 0,
      lte: 1,
      allowEmpty: true,
      allowZeroString: true,
    });
    ok(s, '');
    ok(s, '0');
    ok(s, '1');
    ok(s, '0.5');
    bad(s, '1.0001');
    bad(s, '-0.5');
    // A non-canonical zero ('0.0') is NOT the disabled sentinel, so the bound applies and rejects it.
    bad(s, '0.0');
  });

  it('enforces lt as a strict upper bound', () => {
    const s = decimalString('in (0, 1)', { gt: 0, lt: 1 });
    ok(s, '0.99');
    bad(s, '1');
    bad(s, '1.5');
  });

  it('uses decimal.js, not Number(), so extreme-precision inputs are judged on the Decimal value', () => {
    const s = decimalString('positive', { gt: 0 });
    // A value below Number.MIN_VALUE rounds to 0 under IEEE-754 Number() but is
    // a genuine positive under decimal.js; the helper must accept it.
    ok(s, '1e-330');
  });

  it('surfaces the caller-supplied message on rejection (the factory keeps per-field text)', () => {
    const r = decimalString('must be a positive decimal', { gt: 0 }).safeParse('0');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe('must be a positive decimal');
  });

  it('chains .default() and .describe() returning a plain string schema', () => {
    const s = decimalString('positive', { gt: 0 }).default('3').describe('a knob');
    expect(s.parse(undefined)).toBe('3');
    expect(s.parse('5')).toBe('5');
  });

  // A decimalString field rendered in the SPA validates client-side via ajv
  // against the JSON Schema produced by z.toJSONSchema. The Decimal bounds ride
  // on a zod .refine(), which is unrepresentable in JSON Schema and dropped at
  // conversion, so without a representable check ajv accepts a blank/garbage
  // value and the rejection only happens server-side. A decimal-format `.regex`
  // is representable, so it is emitted as `pattern` and ajv enforces it.
  describe('emits a JSON-Schema pattern so blank/malformed input is caught client-side', () => {
    const toJson = (s: z.ZodType<string>): { pattern?: string } =>
      z.toJSONSchema(s, { unrepresentable: 'any', io: 'input' }) as { pattern?: string };

    it('emits a pattern that rejects blank and non-decimal input but accepts decimals', () => {
      const { pattern } = toJson(decimalString('positive', { gt: 0 }));
      expect(pattern).toBeDefined();
      const re = new RegExp(pattern ?? '');
      expect(re.test('')).toBe(false);
      expect(re.test('abc')).toBe(false);
      expect(re.test('0.5')).toBe(true);
      expect(re.test('25')).toBe(true);
      expect(re.test('-0.5')).toBe(true);
      // Must not over-reject: scientific notation and decimal.js-valid extremes.
      expect(re.test('1e-330')).toBe(true);
    });

    it('emits a pattern that accepts blank for an allowEmpty field (the inherit sentinel)', () => {
      const { pattern } = toJson(decimalString('opt', { gt: 0, allowEmpty: true }));
      expect(pattern).toBeDefined();
      const re = new RegExp(pattern ?? '');
      expect(re.test('')).toBe(true);
      expect(re.test('0.5')).toBe(true);
      expect(re.test('abc')).toBe(false);
    });

    it('emits a pattern that admits the allowZeroString sentinel but still rejects blank', () => {
      // allowZeroString lets the literal '0' through the refine; the regex must
      // also admit '0' (it does, as a plain decimal) without admitting blank.
      const { pattern } = toJson(decimalString('opt', { gt: 0, lte: 1, allowZeroString: true }));
      const re = new RegExp(pattern ?? '');
      expect(re.test('0')).toBe(true);
      expect(re.test('')).toBe(false);
    });
  });
});
