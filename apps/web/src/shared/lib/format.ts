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
 * Format a decimal-string money amount for display. Quote-asset P/L is money, not a base-asset quantity, so values at or above 1 render at a fixed 2 fraction digits. A sub-unit value (a few cents of USDT, or a BTC-quoted P/L) keeps 4 significant digits, because 2 rounds by up to 5% and hides real money in a BTC-quoted profile: `-0.0348491` reads `-0.03485` rather than the 8-digit noise a glance cannot parse, and a tiny amount like `0.00000306` still reads `0.00000306` instead of rounding away to `0.00`.
 *
 * @param value - The amount as a decimal string.
 * @returns The display string, or the input unchanged when it is not a finite number.
 */
export function formatMoneyAmount(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n.toLocaleString(
    undefined,
    // Judged on the rounded value: 0.99996 rounds up to 1 at 4 significant digits and must then read 1.00 like any other whole amount.
    Math.abs(Number(n.toPrecision(4))) >= 1
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : { maximumSignificantDigits: 4 },
  );
}

/**
 * Format a decimal-string price for display. At or above 1 a price shares money's 2dp, so a round 68000 and a live 76,700.76 align in one column. Below 1 it keeps up to 8 fraction digits with trailing zeros dropped, because an exchange price is tick-quantised and Binance quotes at most 8dp: every digit shown is a real tick, so ZECBTC `0.0148267` (tickSize `0.0000001`) must not collapse to `0.01483`, while DOGE `0.08584` still reads `0.08584`.
 *
 * @param value - The price as a decimal string.
 * @returns The display string, or the input unchanged when it is not a finite number.
 */
export function formatPrice(value: string): string {
  const n = Number(value);
  // Judged on the 8dp-rounded value, so a sub-1 input finer than a tick that rounds up to 1 reads 1.00 like any whole price.
  if (!Number.isFinite(n) || Math.abs(Math.round(n * 1e8)) >= 1e8) return formatMoneyAmount(value);
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
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
 * Render a win-rate ratio (0..1, the API/contract shape) as a whole percent. A share of trades is a count ratio, so `72%` says everything `72.00%` does, and the whole-percent form matches `winPct` on the History surfaces.
 *
 * @param ratio - Wins over valued trades, 0..1.
 * @returns A whole percent with a trailing %, e.g. 72%.
 */
export function formatWinRate(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

const HOLD_DAY_MS = 24 * 60 * 60 * 1000;
const HOLD_HOUR_MS = 60 * 60 * 1000;

/**
 * A holding period at the scale a reader can hold in their head: days past a day, else hours, else minutes.
 *
 * Rounded arithmetic rather than `toFixed`, which would pad a whole number to `3.0d` and put another entry in the reviewed fixed-precision inventory for a figure that is not money.
 *
 * @param ms - Elapsed milliseconds, or null/undefined when nothing could be timed.
 * @returns The rounded figure with its unit, or an em dash. Never `0m`, which would claim a cycle that opened and closed in the same instant.
 */
export function formatHoldDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms >= HOLD_DAY_MS) return `${Math.round((ms / HOLD_DAY_MS) * 10) / 10}d`;
  if (ms >= HOLD_HOUR_MS) return `${Math.round(ms / HOLD_HOUR_MS)}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}
