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

// Decimal-format matcher: optional sign, digits with an optional single point, optional scientific exponent. Representable in JSON Schema as `pattern`, so `z.toJSONSchema` emits it and the SPA's ajv enforces it client-side. The Decimal bounds below ride on a `.refine` that JSON Schema cannot carry, so without this a blank/garbage value would only be rejected server-side. The matcher is intentionally a superset of the numeric bounds (it asserts "is a decimal", not the range), so it rejects only forms no canonical `Decimal#toString` emits. It does reject hand-typed hex/binary/octal base prefixes (0x.., 0b.., 0o..) that decimal.js would accept; no producer or form input ever emits those.
//
// The two digit runs must NOT be adjacent. Spelled `(\d+\.?\d*|\.\d+)` — a mandatory run, an OPTIONAL point, then a second run — the engine can split a long digit string at every position, so an anchored reject (`'9'.repeat(n) + '!'`) is O(n squared): measured 1.4ms at 1,000 digits, 25.6ms at 4,000, 420ms at 16,000 and 1,619ms at 32,000. Nesting the fraction behind a mandatory point, `\d+(?:\.\d*)?`, is the shape decimal.js's own input gate uses; it accepts an identical language and rejects in linear time (0.1ms at 32,000). Since this regex now runs FIRST on every inbound decimal field, the quadratic form would be a denial of service in its own right — the exact hazard it was moved here to prevent. Groups are non-capturing because nothing reads them; only `.test()` and zod's `.regex()` consume these.
// Declared here rather than beside its other consumer because `isWireDecimal` must run it FIRST, before constructing a Decimal. Base-prefixed input is not merely unwanted, it is a denial of service: decimal.js converts a non-decimal base with a quadratic `convertBase`, measured at 8.9ms for 4000 hex digits, 35.7ms for 8000 and 149.5ms for 16000 — doubling the input quadruples the time, so a one-megabyte body is minutes of blocked event loop from a single request, on routes that carry neither `requireNotDemo` nor a body-size limit.
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

// Largest base-10 exponent a wire decimal may carry. What justifies it differs by side, and NEITHER side is a representability guarantee — read the next paragraph before citing this constant as one.
//
// Above +308: the neighbourhood where a `DecimalString` stops surviving the JS double every consumer eventually narrows it through — a chart series, a `Number()` in the SPA, a JSON number in a notifier payload. `Number.MAX_VALUE` is 1.7976931348623157e308, and this check reads only the EXPONENT, so it is a decade-granularity stop rather than an exact one: `9e308` and `1.8e308` both report `e === 308`, both are accepted here, and both are `Infinity` once a reader calls `Number()` on them. That imprecision is deliberate. A mantissa-exact cut at `Number.MAX_VALUE` would buy nothing — no exchange quotes a price, quantity or balance within thirty orders of magnitude of it — and the expansion argument below already justifies the bound on its own. The honest reading is "past this, it is no longer money", not "past this, it is unrepresentable".
//
// Below -308: the mirror argument does not hold at all. Subnormals run down to `Number.MIN_VALUE` (5e-324), so `1e-320` really does survive a double. This half rests purely on expansion cost: an accepted value is immediately spelled out in full by `toFixed()`, so a twelve-byte `1e-10000000` becomes a ten-million-character string on a route with no `requireNotDemo`. The bound is symmetric because 308 fraction digits is already far past any exchange's precision, not because 1e-309 is unrepresentable.
//
// Read off `Decimal#e`, which needs no expansion, and checked BEFORE anything formats the value. Do NOT reach for a max-length cap instead: plain-decimal parsing is linear (10k digits 0.3ms, 1M digits 10.5ms) so length is not the hazard, and an accepted value's `toFixed()` output can be LONGER than its input (`1e-308` is 6 characters in, 310 out). A cap sized on the input would therefore reject a body the route itself just produced, turning a 200 into a 500 on every route that re-parses its own response — `account-health`, `status`, `exchange-info`, `dust-transfer` and `ops-notify` do that today, and the list is a property of the route, not a number worth pinning here.
const MAX_WIRE_EXPONENT = 308;

// Matches a literal whose mantissa is zero, whatever its exponent: `0`, `0.00`, `0.0e5`.
const ZERO_MANTISSA_RE = /^[+-]?(?:0+\.?0*|\.0+)(?:[eE][+-]?\d+)?$/;

// The wire predicate: decimal-shaped, finite, and inside the exponent bound. Deliberately NOT the predicate `decimalString` refines on — that helper produces a plain `string` for strategy configs, never a wire brand, and it accepts sub-double magnitudes on purpose so an operator's `1e-330` knob is judged on its Decimal value rather than on what a double can hold.
//
// The zero arm is not a nicety, it is the bound's only leak. decimal.js clamps anything under `minE` (-9e15) to an exact zero, so the clamped value reports `e === 0` and post-construction `d.e` cannot tell a real zero from a laundered underflow: `1e-9000000000000001` sails through the exponent check that correctly stops the far tamer `1e-10000000`. Going MORE extreme is what defeats it. The mantissa is therefore read off the input string, which the clamp has not touched.
//
// No try/catch: `DECIMAL_RE` has already established the string is decimal-shaped, and decimal.js throws only on an argument it cannot parse, so the construction below cannot throw. A catch here would be an unreachable branch, not a safety net.
const isWireDecimal = (s: string): boolean => {
  if (!DECIMAL_RE.test(s)) return false;
  const d = new Decimal(s);
  if (!d.isFinite()) return false;
  if (d.isZero()) return ZERO_MANTISSA_RE.test(s);
  return Math.abs(d.e) <= MAX_WIRE_EXPONENT;
};

// Every schema in this module that carries the decimal-string contract, recorded by object identity. A static guard cannot ask a zod schema what it validates, so it recognises a decimal field by comparing the schema object it finds in a `.shape` against the ones declared here; `decimalString` is a factory and mints a fresh object per call, which identity comparison alone would miss, so the factory registers its result too. Membership is what makes the derived field-name set complete — the alternative is a hand-maintained list of field names, which fails open on every field nobody remembered.
//
// A WeakSet rather than zod's `.meta()`: metadata is merged into `z.toJSONSchema` output, so tagging the schema that way would change the JSON Schema the config-schema and form-builder routes emit. This registry is invisible to parsing, serialisation and the wire.
const decimalStringSchemas = new WeakSet<object>();

/**
 * Whether a zod schema carries the decimal-string contract — either one of this module's shared constants or a bounded field minted by {@link decimalString}.
 *
 * @param schema - Any value found in a zod object's `.shape`; non-objects answer `false` rather than throwing, so a walker can ask about anything it encounters.
 * @returns True when the value renders as a decimal string and therefore must be formatted before it reaches a display surface.
 */
export const isDecimalStringSchema = (schema: unknown): boolean =>
  typeof schema === 'object' && schema !== null && decimalStringSchemas.has(schema);

/**
 * Zod schema that parses to {@link DecimalString}. Refuses NaN/±Infinity and any value past {@link MAX_WIRE_EXPONENT}, so a malformed Binance response can't poison downstream math; the brand is added via `transform` to keep the TypeScript boundary tight.
 *
 * The transform also normalises: it yields exactly what {@link asDecimalString} would. The schema is one definition used on the way in AND on the way out, so without this a value that arrived as `1e-8` or as a scale-padded `1.10000000` numeric(38,18) read would cross the wire in that spelling while the same field built by a producer went out plain — one field, two grammars, decided by which door the value came through. Normalising here is the only placement that covers both doors.
 */
export const DecimalString: z.ZodType<DecimalString> = z
  .string()
  .refine(isWireDecimal, { message: 'expected decimal-string' })
  // Arrow form, not a bare `.transform(asDecimalString)`: `asDecimalString` is declared further down this module, so a bare reference is read at schema-construction time — in its temporal dead zone — and throws on import.
  .transform((s) => asDecimalString(s));

/**
 * Strictly-positive decimal-string. Refuses NaN/±Infinity, any value past {@link MAX_WIRE_EXPONENT}, and zero or negative values. Use on money-path payload fields where 0 or negative is never a legitimate operator value (order size, price, avg-entry-price) so the API rejects the request with a precise 400 instead of silently enqueuing an order the worker will then drop with a `min-qty` skip.
 *
 * Normalises on the way out exactly as {@link DecimalString} does.
 */
export const PositiveDecimalString: z.ZodType<DecimalString> = z
  .string()
  .refine(isWireDecimal, { message: 'expected decimal-string' })
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
  .transform((s) => asDecimalString(s));

// Registered after declaration rather than through a wrapping helper so each schema above still reads as a plain zod chain.
decimalStringSchemas.add(DecimalString);
decimalStringSchemas.add(PositiveDecimalString);

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

// The {@link DECIMAL_RE} form plus the empty string: allowEmpty fields treat '' as the "inherit / blank" sentinel, so their pattern must admit it.
const DECIMAL_OR_EMPTY_RE = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)?$/;

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
): z.ZodType<string> => {
  const schema = z
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
  decimalStringSchemas.add(schema);
  return schema;
};

// The canonical wire form is `Decimal#toFixed()`, never `toString()`. `toString()` switches to exponential outside decimal.js's `toExpNeg`/`toExpPos` thresholds (-7 and 21 by default), so a stored `0.00000036` commission leaves as `3.6e-7`. Every consumer interpolates a money field verbatim — the SPA prints it into a table cell, a notifier drops it into a message — and an exponent there reads as a corrupted value beside a column of fixed-decimal numbers. `toFixed()` has no such threshold and is exact for any magnitude, so it is applied in each helper below rather than once in a wrapper: each one independently reaches the wire.
//
// A caller that writes `new Decimal(x).toString() as DecimalString` mints the brand without the formatting, and the cast makes that invisible to the type system — `tsc` sees a `DecimalString` either way. Two things close it: the `DecimalString` schema now normalises on parse, so any value that crosses a zod boundary is re-spelled regardless of how it was built, and `scripts/ci/no-decimal-tostring-cast.sh` fails the build on the cast itself, for the routes that hand a body straight to `c.json` without a parse.

/**
 * Constructs a {@link DecimalString} from any decimal-shaped input. Centralised so producers share one formatting decision instead of each reaching for `String(x)` and picking up a locale or `Number` round-trip.
 *
 * @param v - Any decimal-shaped value: a decimal-string, a `Decimal`, or a JS number already known to be exact.
 * @returns The value in plain decimal notation, branded for the wire.
 */
export const asDecimalString = (v: string | Decimal | number): DecimalString =>
  new Decimal(v).toFixed() as DecimalString;

/**
 * Adds two decimal-strings.
 *
 * @param a - Left addend as a decimal-string.
 * @param b - Right addend as a decimal-string.
 * @returns The sum in plain decimal notation, branded for the wire.
 */
export const decimalAdd = (a: string, b: string): DecimalString =>
  new Decimal(a).plus(new Decimal(b)).toFixed() as DecimalString;

/**
 * Subtracts `b` from `a` (decimal-strings).
 *
 * @param a - Minuend as a decimal-string.
 * @param b - Subtrahend as a decimal-string.
 * @returns The difference in plain decimal notation, branded for the wire.
 */
export const decimalSub = (a: string, b: string): DecimalString =>
  new Decimal(a).minus(new Decimal(b)).toFixed() as DecimalString;

/**
 * Multiplies two decimal-strings.
 *
 * @param a - Left factor as a decimal-string.
 * @param b - Right factor as a decimal-string.
 * @returns The product in plain decimal notation, branded for the wire.
 */
export const decimalMul = (a: string, b: string): DecimalString =>
  new Decimal(a).times(new Decimal(b)).toFixed() as DecimalString;
