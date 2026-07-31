import Decimal from 'decimal.js';

/**
 * Format `value` using exactly the decimal places carried by `step`. Binance
 * rejects orders whose serialised quantity has more precision than the
 * LOT_SIZE step; this helper centralises the `toFixed(step.decimalPlaces())`
 * idiom so every callsite formats the same way.
 */
export const toFixedStep = (value: Decimal, step: Decimal): string =>
  value.toFixed(step.decimalPlaces());

/**
 * Parse a decimal-string into Decimal. Wrapper around `new Decimal(s)` so
 * consumers can route every wire-to-runtime conversion through one symbol;
 * makes a future change of the underlying engine a one-line edit.
 */
export const parseDecimal = (s: string): Decimal => new Decimal(s);

/**
 * Whether `s` parses to a finite Decimal. Used at API boundaries where a
 * malformed Binance response could otherwise poison downstream math through
 * NaN / Infinity propagation.
 */
export const isFiniteDecimalString = (s: string): boolean => {
  try {
    return new Decimal(s).isFinite();
  } catch {
    return false;
  }
};

/**
 * Whether `s` is a plain decimal string: optional leading minus, then an
 * integer with optional fraction, or a bare fraction. Rejects scientific
 * notation, hex / octal / binary prefixes, digit separators, leading plus,
 * Infinity, NaN, and the empty string. This is the grammar both Binance
 * wire balances and strategy-produced order quantities stay within, so it
 * is the canonical guard at boundaries that must reject anything `decimal.js`
 * would parse but the wire never legitimately produces. Prefer this over
 * `isFiniteDecimalString` when the accepted set should match the wire, not
 * decimal.js's full input domain.
 */
const PLAIN_DECIMAL_RE = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
export const isPlainDecimalString = (s: string): boolean => PLAIN_DECIMAL_RE.test(s);
