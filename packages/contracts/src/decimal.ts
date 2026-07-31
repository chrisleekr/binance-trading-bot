import Decimal from 'decimal.js';
import { z } from 'zod';

// Decimal-string brand. Money fields cross the wire as decimal-strings (never
// JS numbers). Strategies revive into `Decimal` (decimal.js) at the boundary.
declare const _decimalBrand: unique symbol;
/**
 * Branded decimal-string. The brand keeps a raw `string` from being passed
 * where a money value is expected. IEEE-754 has bitten this codebase before
 * so the type system enforces the wire contract.
 */
export type DecimalString = string & { readonly [_decimalBrand]: 'DecimalString' };

const isWellFormed = (s: string): boolean => {
  try {
    const d = new Decimal(s);
    return d.isFinite();
  } catch {
    return false;
  }
};

/**
 * Zod schema that parses to {@link DecimalString}. Refuses NaN/±Infinity so a
 * malformed Binance response can't poison downstream math; the brand is added
 * via `transform` to keep the TypeScript boundary tight.
 */
export const DecimalString: z.ZodType<DecimalString> = z
  .string()
  .refine(isWellFormed, { message: 'expected decimal-string' })
  .transform((s) => s as DecimalString);

/**
 * Strictly-positive decimal-string. Refuses NaN/±Infinity and rejects zero or
 * negative values. Use on money-path payload fields where 0 or negative is
 * never a legitimate operator value (order size, price, avg-entry-price) so the
 * API rejects the request with a precise 400 instead of silently enqueuing an
 * order the worker will then drop with a `min-qty` skip.
 */
export const PositiveDecimalString: z.ZodType<DecimalString> = z
  .string()
  .refine(isWellFormed, { message: 'expected decimal-string' })
  // Guard the Decimal construction: zod runs every `.refine` even after an
  // earlier one fails, so on a non-numeric string this check still executes —
  // an unguarded `new Decimal(s)` would THROW out of `safeParse` (a 500 at the
  // API boundary, a dead button in the UI) instead of returning a clean failed
  // parse. Catch it so a malformed value is a normal validation failure.
  .refine(
    (s) => {
      try {
        return new Decimal(s).gt(0);
      } catch {
        return false;
      }
    },
    { message: 'must be greater than zero' },
  )
  .transform((s) => s as DecimalString);

/**
 * Inclusive/exclusive numeric bounds for {@link decimalString}. Bound values are
 * decimal-shaped (number or a well-formed decimal string); a malformed bound
 * literal throws at parse time (caller contract — every in-repo caller passes a
 * numeric literal).
 */
export interface DecimalStringBounds {
  readonly gt?: number | string;
  readonly gte?: number | string;
  readonly lt?: number | string;
  readonly lte?: number | string;
  /** When true, the empty string passes (the operator's "field left blank / inherit" sentinel). */
  readonly allowEmpty?: boolean;
  /** When true, the literal `'0'` passes (the operator's "knob disabled" sentinel, distinct from a real zero value). */
  readonly allowZeroString?: boolean;
}

// Decimal-format matcher: optional sign, digits with an optional single point,
// optional scientific exponent. Representable in JSON Schema as `pattern`, so
// `z.toJSONSchema` emits it and the SPA's ajv enforces it client-side. The
// Decimal bounds below ride on a `.refine` that JSON Schema cannot carry, so
// without this a blank/garbage value would only be rejected server-side. The
// matcher is intentionally a superset of the numeric bounds (it asserts "is a
// decimal", not the range), so it rejects only forms no canonical
// `Decimal#toString` emits. It does reject hand-typed hex/binary/octal base
// prefixes (0x.., 0b.., 0o..) that decimal.js would accept; no producer or form
// input ever emits those.
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
// allowEmpty fields treat '' as the "inherit / blank" sentinel, so the pattern
// must also admit the empty string for those fields.
const DECIMAL_OR_EMPTY_RE = /^([+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)?$/;

/**
 * Builds a money-string field validator: a plain `string` schema (NOT the
 * branded {@link DecimalString}, so config field types stay `string` and no
 * brand cascades through strategy configs) that rejects NaN/±Infinity and
 * enforces the given Decimal bounds. Strategy schemas re-implemented this same
 * refine per field with a hand-rolled `Number()` parse; `Number()` is IEEE-754
 * and can disagree with the Decimal money path on extreme inputs, so validation
 * and the runtime that consumes the value could split. Centralising the parse
 * on decimal.js keeps the two in lock-step. The caller supplies the message and
 * bounds so each field keeps its own precise operator-facing error text.
 *
 * The leading `.regex` is a decimal-format gate (see {@link DECIMAL_RE}): the
 * only part of the contract that JSON Schema can carry, so blank/malformed
 * input is caught client-side instead of surviving to a server 400. The numeric
 * bounds stay on the `.refine`, server-authoritative.
 */
export const decimalString = (
  message: string,
  bounds: DecimalStringBounds = {},
): z.ZodType<string> =>
  z
    .string()
    .regex(bounds.allowEmpty ? DECIMAL_OR_EMPTY_RE : DECIMAL_RE, { message })
    .refine(
      (raw) => {
        if (bounds.allowEmpty && raw === '') return true;
        if (bounds.allowZeroString && raw === '0') return true;
        if (!isWellFormed(raw)) return false;
        const d = new Decimal(raw);
        if (bounds.gt !== undefined && !d.gt(bounds.gt)) return false;
        if (bounds.gte !== undefined && !d.gte(bounds.gte)) return false;
        if (bounds.lt !== undefined && !d.lt(bounds.lt)) return false;
        if (bounds.lte !== undefined && !d.lte(bounds.lte)) return false;
        return true;
      },
      { message },
    );

/**
 * Constructs a {@link DecimalString} from any decimal-shaped input. Centralised
 * so the canonical `Decimal#toString()` formatting is the only place values
 * enter the wire, preventing accidental locale or `Number` round-trips.
 */
export const asDecimalString = (v: string | Decimal | number): DecimalString =>
  new Decimal(v).toString() as DecimalString;

/** Adds two decimal-strings, returning a canonical {@link DecimalString}. */
export const decimalAdd = (a: string, b: string): DecimalString =>
  new Decimal(a).plus(new Decimal(b)).toString() as DecimalString;

/** Subtracts `b` from `a` (decimal-strings), returning a canonical {@link DecimalString}. */
export const decimalSub = (a: string, b: string): DecimalString =>
  new Decimal(a).minus(new Decimal(b)).toString() as DecimalString;

/** Multiplies two decimal-strings, returning a canonical {@link DecimalString}. */
export const decimalMul = (a: string, b: string): DecimalString =>
  new Decimal(a).times(new Decimal(b)).toString() as DecimalString;
