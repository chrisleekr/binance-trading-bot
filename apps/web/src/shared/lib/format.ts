// Display formatting for decimal-string money values. apps/web is barred from
// decimal.js; these are display-only Number coercions at the render boundary,
// never feeding an order (CLAUDE.md money-math rule).

/**
 * Format a decimal-string or number amount for display: thousands separators,
 * up to 8 fraction digits, trailing zeros dropped. Accepts a number so a value
 * already computed in the component (a spread, a projected cost) shares this
 * one precision policy instead of re-inlining `toLocaleString`. Returns the
 * input as a string when it is not finite, so a malformed value is shown
 * rather than `NaN`.
 */
export function formatAmount(value: string | number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

/**
 * Format a crypto-asset balance with consistent column alignment. Unlike
 * {@link formatAmount}, this pads sub-1 values to at least 4 fraction digits
 * and integer values to at least 2, so a whole-number balance reads as
 * `1.00` instead of the bare `1` that sticks out in a column of decimals.
 * Always caps at 8 fraction digits — Binance's largest step-size.
 * Stablecoins (whose ticker resolves to a small set) keep 2dp via
 * {@link formatMoneyAmount} at the call site; this helper targets base-
 * asset crypto rows where precision varies symbol-to-symbol.
 */
export function formatBalanceAmount(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const abs = Math.abs(n);
  const opts: Intl.NumberFormatOptions =
    abs === 0
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : abs >= 1
        ? { minimumFractionDigits: 2, maximumFractionDigits: 8 }
        : { minimumFractionDigits: 4, maximumFractionDigits: 8 };
  return n.toLocaleString(undefined, opts);
}

/**
 * Format a quote-asset (money) balance: 2 fraction digits at or above 1 so a
 * USDT wallet reads `29.16`, not the 8-digit `29.15892558` that a base-asset
 * quantity needs. A sub-unit quote (e.g. a BTC-quoted pair) keeps up to 8
 * digits so it does not round to `0.00`. Min 2 digits everywhere keeps the
 * `0.00 locked` column aligned with the base row. The money counterpart to
 * {@link formatBalanceAmount}; the balances panel picks per leg of the pair.
 */
export function formatBalanceMoney(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString(
    undefined,
    Math.abs(n) >= 1
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 8 },
  );
}

/**
 * Sign of a decimal-string number, for colouring PnL-style values:
 * `pos` / `neg` / `zero`. A non-finite or absent input reads as `zero`.
 */
export function signOf(value: string | null | undefined): 'pos' | 'neg' | 'zero' {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 'zero';
  return n > 0 ? 'pos' : 'neg';
}

/**
 * Format a decimal-string money amount for display. Quote-asset P/L is money,
 * not a base-asset quantity — 8 fraction digits is noise on a USDT readout, so
 * values at or above 1 render at a fixed 2 fraction digits. A sub-unit value
 * (e.g. a BTC-quoted P/L) keeps up to 8 digits so it does not round away to
 * `0.00`. Returns the input unchanged when it is not a finite number.
 */
export function formatMoneyAmount(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString(
    undefined,
    Math.abs(n) >= 1
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { maximumFractionDigits: 8 },
  );
}

/**
 * Format a decimal-string price for display. Prices are quote-asset money,
 * so they need the same 2dp precision as P/L on a USDT readout (otherwise a
 * round 68000 renders next to a 76,700.76 and the eye stutters between
 * rows). Values at or above 1 round to 2 fraction digits; a sub-1 price
 * (e.g. a SHIB-denominated quote) keeps up to 8 digits so it does not round
 * to 0. The contract coincides with `formatMoneyAmount` today but is
 * deliberately a wrapper, not an alias, so a P/L-specific tweak (sign
 * affordance, trailing-zero elision) does not silently change price
 * rendering.
 */
export function formatPrice(value: string): string {
  return formatMoneyAmount(value);
}

/**
 * Format a decimal-string money amount with an explicit sign — a positive
 * value gains a leading `+`, a negative keeps its `-`. For PnL-style readouts
 * where the direction must be visible at a glance.
 */
export function formatSignedAmount(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const formatted = formatMoneyAmount(value);
  return n > 0 ? `+${formatted}` : formatted;
}

/**
 * A number at a fixed 2 fraction digits, with negative zero normalised: a value
 * whose 2dp rounding is zero (e.g. a tiny fee-only loss) renders as "-0.00",
 * which reads as a sign glitch, so collapse it to "0.00".
 */
export function formatFixed2(n: number): string {
  const s = n.toFixed(2);
  return s === '-0.00' ? '0.00' : s;
}

/**
 * {@link formatFixed2} with a trailing percent sign. Pass `{ sign: true }` to
 * prefix a `+` on strictly positive values (for a signed P/L readout); the
 * `-0.00 -> 0.00` normalization is inherited from {@link formatFixed2}, so a
 * tiny negative that rounds to zero never renders as `-0.00%`.
 */
export function formatPercent(n: number, opts?: { sign?: boolean }): string {
  const prefix = opts?.sign && n > 0 ? '+' : '';
  return `${prefix}${formatFixed2(n)}%`;
}

/**
 * Render a win-rate ratio (0..1, the API/contract shape) as a percent. Owns the
 * `*100` scale + rounding that the dashboards previously hand-applied
 * inconsistently (one 2-dp, one integer); standardised on the {@link formatPercent}
 * house style so every win-rate readout matches.
 */
export function formatWinRate(ratio: number): string {
  return formatPercent(ratio * 100);
}
