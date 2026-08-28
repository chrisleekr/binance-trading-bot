import Decimal from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  asDecimalString,
  decimalAdd,
  decimalMul,
  decimalString,
  DecimalString,
  decimalSub,
  PositiveDecimalString,
} from '../src/decimal.js';

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

  // Both schemas are one shared definition used inbound AND outbound, so whatever they yield is what a consumer interpolates verbatim into a table cell or a notifier message. Accepting a value and handing back its exponential spelling makes the brand a promise the schema does not keep, and the cast sites that mint the brand by hand are invisible to `tsc`. Normalising at the schema closes both.
  const parsed = (schema: z.ZodType<string>, value: string): string => {
    const r = schema.safeParse(value);
    expect(r.success).toBe(true);
    return r.success ? r.data : '';
  };

  it('yields plain notation for an accepted scientific-notation value', () => {
    expect(parsed(DecimalString, '1e-8')).toBe('0.00000001');
    expect(parsed(PositiveDecimalString, '1e-8')).toBe('0.00000001');
    expect(parsed(DecimalString, '-1.5e-9')).toBe('-0.0000000015');
    expect(parsed(DecimalString, '1e21')).toBe('1000000000000000000000');
  });

  it('canonicalises a plain value, dropping the trailing zeros a numeric(38,18) read carries', () => {
    expect(parsed(DecimalString, '1.10')).toBe('1.1');
    expect(parsed(PositiveDecimalString, '1.10')).toBe('1.1');
    expect(parsed(DecimalString, '2.000000000000000000')).toBe('2');
  });

  it('yields exactly what asDecimalString would, and is idempotent so a re-parse does not drift', () => {
    // Single-sourcing the answer on the encoder is the point: a producer that already routed through `asDecimalString` and a raw Binance string that arrived scientific must land on the same bytes, or the same field carries two spellings depending on which door it came through.
    for (const input of ['1e-8', '1.10', '-1.5e-9', '0.00000036', '2.000000000000000000']) {
      const once = parsed(DecimalString, input);
      expect(once).toBe(asDecimalString(input));
      expect(parsed(DecimalString, once)).toBe(once);
    }
  });

  it('pins both sides of the wire exponent bound, so the constant cannot drift unnoticed', () => {
    // Without this the constant could be 22 or 9,999,999 and every other assertion in this file would still pass. Both schemas, both directions, one decade either side of the edge.
    for (const schema of [DecimalString, PositiveDecimalString]) {
      ok(schema, '1e308');
      ok(schema, '1e-308');
      bad(schema, '1e309');
      bad(schema, '1e-309');
    }
  });

  it('rejects an exponent past the wire bound WITHOUT materialising the expansion', () => {
    // `1e-10000000` is a legal decimal.js value whose plain spelling is ten million characters. Expanding it to answer a validation question hands an anonymous caller (symbols.ts / manual-orders.ts have no requireNotDemo) a memory amplification on one request body, so the bound is read off the exponent and checked before anything formats the value.
    // Asserted structurally rather than on a stopwatch: a wall-clock ceiling is flaky under CI load AND weak, because a rope-string concatenation can build the expansion well inside a second and pass in exactly the world the case exists to exclude. `toFixed` is the only thing that can allocate the expansion, so "it was never called" is the property, and it cannot pass unfixed.
    const spy = vi.spyOn(Decimal.prototype, 'toFixed');
    try {
      for (const schema of [DecimalString, PositiveDecimalString]) {
        bad(schema, '1e-10000000');
        bad(schema, '1e10000000');
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects both directions of a decimal.js exponent clamp', () => {
    // decimal.js clamps at both ends and the two clamps hide in different places, so each needs its own arm and its own case.
    // Underflow, below `minE` (-9e15), clamps to an EXACT ZERO: the clamped value reports `e === 0` and the exponent check sees a perfectly ordinary zero, so going MORE extreme is what defeats the bound — `1e-9000000000000001` was accepted and yielded `'0'` while the far tamer `1e-10000000` was correctly refused. The mantissa is therefore read off the input string, which the clamp never touched.
    bad(DecimalString, '1e-9000000000000001');
    bad(PositiveDecimalString, '1e-9000000000000001');
    // Overflow, above `maxE`, clamps to INFINITY, which the `isFinite` arm stops. A clamped literal is now the ONLY way to reach that arm: the shape gate runs first and rejects the words `Infinity` and `NaN` outright, so without this case the arm is dead code against a coverage floor rather than a guard anyone has driven.
    bad(DecimalString, '1e9000000000000001');
    bad(PositiveDecimalString, '1e9000000000000001');
    // The same check must not swallow a genuine zero, whatever exponent it is written with.
    ok(DecimalString, '0');
    ok(DecimalString, '0.00');
    ok(DecimalString, '0.0e5');
    expect(parsed(DecimalString, '0.0e5')).toBe('0');
  });

  it('rejects a long digit run in linear time, so the shape gate cannot be the denial of service it prevents', () => {
    // The decimal-shape gate runs FIRST on every inbound field, so its own worst case is the hot path. Spelled with two ADJACENT unbounded runs — `(\d+\.?\d*|\.\d+)`, a mandatory run then an optional point then a second run — an anchored reject backtracks over every split point and costs O(n squared): 1.4ms at 1,000 digits, 25.6ms at 4,000, 420ms at 16,000, 1,619ms at 32,000. Nesting the fraction behind a mandatory point accepts the identical language and rejects linearly.
    // Pinned two ways, because either alone is escapable. The wall clock is generously bounded so it is not flaky, but 200,000 digits under the quadratic form does not finish in any bound worth writing; and the source pin fails the moment someone restores the adjacent spelling, even on a machine fast enough to hide it.
    // The source pin runs FIRST: it is deterministic and instant, so a restored quadratic form fails in milliseconds instead of after the three minutes the hostile input below then takes to reject. The emitted JSON-Schema pattern IS the regex source, so this reads the shipping regex rather than a copy of it, and both grammars are pinned because both are reachable from operator input.
    const patternOf = (schema: z.ZodType<string>): string =>
      (z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as { pattern?: string })
        .pattern ?? '';
    for (const pattern of [
      patternOf(decimalString('positive', { gt: 0 })),
      patternOf(decimalString('opt', { gt: 0, allowEmpty: true })),
    ]) {
      expect(pattern).not.toMatch(/\\d\+\\\.\?\\d\*/);
      expect(pattern).toContain('\\d+(?:\\.\\d*)?');
    }

    // And the behaviour itself, on the branded schemas the source pin cannot reach (their regex is not emitted as a pattern). The bound is generous rather than tight so it is not flaky; 200,000 digits under the quadratic form took 198 seconds when measured, which no bound worth writing would admit.
    const hostile = '9'.repeat(200_000) + '!';
    const started = Date.now();
    expect(DecimalString.safeParse(hostile).success).toBe(false);
    expect(PositiveDecimalString.safeParse(hostile).success).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('rejects a base-prefixed literal before constructing a Decimal', () => {
    // decimal.js accepts hex/binary/octal and converts them with a quadratic `convertBase`: 4,000 hex digits measured 8.9ms, 8,000 35.7ms, 16,000 149.5ms. Doubling the input quadruples the work, so a one-megabyte body is minutes of blocked event loop from a single anonymous request. The decimal-shape gate runs first, which is what keeps the construction off the hot path entirely.
    bad(DecimalString, '0x1f');
    bad(DecimalString, '0b101');
    bad(DecimalString, '0o17');
    bad(PositiveDecimalString, '0x1f');
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

// Every consumer of a wire money field interpolates the string verbatim: the SPA prints it into a table cell, a notifier drops it into a message. decimal.js switches `toString()` to exponential once the value's decimal exponent reaches `toExpNeg` (-7) — any magnitude below 1e-6, so `9.9e-7` flips while `0.000001` does not — and again at or above `toExpPos` (1e21). A stored `0.00000036` therefore crosses the wire as `3.6e-7` and lands in a column of fixed-decimal numbers. `toFixed()` has no such threshold. Every value routed through these encoders carries the guarantee, so no consumer has to re-litigate it; a caller that casts its own `.toString()` to `DecimalString` bypasses them and gets no such promise.
describe('wire encoders emit plain decimal notation', () => {
  // The `@app/money` grammar, copied rather than imported: `packages/contracts` does not depend on `@app/money` and must not gain one for a test.
  const PLAIN = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

  it('asDecimalString spells every magnitude plainly, past both exponential thresholds', () => {
    // A real stored Binance commission: plain in Postgres, exponential the moment it round-trips through Decimal.
    expect(asDecimalString('0.00000036')).toBe('0.00000036');
    // The 8dp display floor. Binance's smallest step, and the value that must not collapse to `0`.
    expect(asDecimalString('1e-8')).toBe('0.00000001');
    expect(asDecimalString('-1.5e-9')).toBe('-0.0000000015');
    // The exact decade the threshold sits on: this is ABOVE 1e-7 and still flips, because the rule is on the exponent, not on 1e-7 as a magnitude.
    expect(asDecimalString('9.9e-7')).toBe('0.00000099');
    // The upper threshold, reachable by a low-unit-price coin's quantity.
    expect(asDecimalString('1e25')).toBe('10000000000000000000000000');

    // Inputs whose exact output is deliberately not spelled out above, so the grammar check is doing work an equality assertion has not already done. Each one is exponential under `toString`.
    for (const input of ['9.9e-7', '1e-300', '1e21']) {
      expect(asDecimalString(input)).toMatch(PLAIN);
    }
  });

  it('decimalAdd / decimalSub / decimalMul spell a result that crosses a threshold plainly', () => {
    // Arithmetic reaches the threshold from plain-looking operands, so the encoders cannot rely on their inputs already being small enough to notice.
    expect(decimalSub('0.00000040', '0.00000004')).toBe('0.00000036');
    expect(decimalAdd('0.00000003', '0.00000003')).toBe('0.00000006');
    expect(decimalMul('0.0000006', '0.6')).toBe('0.00000036');

    // Far enough below the threshold that writing the expected digits out would obscure rather than pin; the grammar is the whole point of the case.
    expect(decimalMul('1e-150', '1e-150')).toMatch(PLAIN);
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
