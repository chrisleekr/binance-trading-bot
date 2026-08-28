// Trader stats derived from a win/loss rollup bucket — win% and profit factor.
// Shared by the trade-archive page's by-exit-reason / by-source bands and the
// Home scoped-KPI strip's by-source band so the two read identically. The
// quotients here are display ratios, not money: the underlying P/L always
// renders from its verbatim decimal string via PnlValue, never these Number
// parses (the same exception `features/profile/lib/archive-view-model.ts` documents).

/**
 * The win/loss primitives a rollup band derives its trader stats from.
 * `grossProfit`/`grossLoss` are the NET-of-fee winner/loser magnitudes (so
 * profit factor and expectancy are net); `totalFees` is the commissions valued
 * in the quote asset, surfaced as the cycle's fee drag.
 */
export interface RollupStatsBucket {
  readonly tradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly grossProfit: string;
  readonly grossLoss: string;
  readonly totalFees: string;
  /** How well the fee component of these magnitudes is known. Optional because a fixture or a payload written before the tier shipped carries none, and an absent tier reads as `unknown` — the reading that withholds rather than the one that certifies. */
  readonly feeBasis?: string;
}

/** Win rate as a whole-number percent (wins / trades). A display ratio of counts, so Number is fine. */
export function winPct(b: RollupStatsBucket): number {
  if (b.tradeCount === 0) return 0;
  return Math.round((b.wins / b.tradeCount) * 100);
}

/**
 * Average NET win size (gross winners / win count), `null` when there are no
 * winners. A display ratio over the verbatim decimal sum; the money itself
 * always renders from its decimal string, never this Number parse.
 */
export function avgWin(b: RollupStatsBucket): number | null {
  if (b.wins === 0) return null;
  return Number(b.grossProfit) / b.wins;
}

/** Average NET loss size (gross losers / loss count, >= 0), `null` when there are no losers. */
export function avgLoss(b: RollupStatsBucket): number | null {
  if (b.losses === 0) return null;
  return Number(b.grossLoss) / b.losses;
}

/**
 * Expectancy: the average NET-of-fee profit per trade, `(grossProfit -
 * grossLoss) / tradeCount`. The single number that says whether the edge is
 * positive after costs — negative means each trade loses money on average.
 * `null` when there are no trades. A display ratio over verbatim decimal sums.
 */
export function expectancy(b: RollupStatsBucket): number | null {
  if (b.tradeCount === 0) return null;
  return (Number(b.grossProfit) - Number(b.grossLoss)) / b.tradeCount;
}

/**
 * Payoff ratio: average win over average loss. `null` when it cannot be formed
 * (no winners or no losers). Pairs with win% to read expectancy's drivers.
 */
export function payoffRatio(b: RollupStatsBucket): number | null {
  const w = avgWin(b);
  const l = avgLoss(b);
  if (w === null || l === null || l === 0) return null;
  return w / l;
}

/** Two significant figures in plain notation. `toPrecision(2)` would be the obvious call, but it switches to exponential once the exponent drops below -6, so a real sub-microunit figure renders as `3.6e-7` in a line of ordinary numbers. Pinning min and max together keeps `toPrecision`'s trailing-zero padding (`0.5` reads `0.50`, `0` reads `0.0`) without its notation flip. */
const SIG2_PLAIN: Intl.NumberFormatOptions = {
  minimumSignificantDigits: 2,
  maximumSignificantDigits: 2,
};

/**
 * Compact expectancy figure: sign-prefixed (− is U+2212 to match PnlValue's
 * minus), 2 significant figures for sub-1 magnitudes so a small edge doesn't
 * round to 0, else 2 decimals. Display formatting over a verbatim ratio.
 *
 * @param value - Expectancy in quote-asset units per trade, already averaged.
 * @returns The signed figure in plain decimal notation, never an exponent.
 */
export function formatExpectancy(value: number): string {
  const abs = Math.abs(value);
  const body = abs < 1 ? abs.toLocaleString(undefined, SIG2_PLAIN) : abs.toFixed(2);
  return `${value < 0 ? '−' : '+'}${body}`;
}

/**
 * Render a {@link profitFactor} reading for display.
 *
 * Notation only: `profitFactor` has already fixed the precision, so this decides how the resulting number is spelled. A sub-1 factor needs the explicit plain-notation formatter because React stringifies a bare `3.6e-7` verbatim; a factor at or above 1 is already 2 decimals and its default string is correct. No minimum here, unlike {@link formatExpectancy}: the factor's own trailing zeros were already settled upstream, and padding them back would rewrite a rendered `PF 0` into `PF 0.0`.
 *
 * @param value - A non-null {@link profitFactor} result; the unbounded `null` case is the caller's ∞, not this function's business.
 * @returns The factor in plain decimal notation.
 */
export function formatProfitFactor(value: number): string {
  return value < 1
    ? value.toLocaleString(undefined, { maximumSignificantDigits: 2 })
    : String(value);
}

/**
 * Profit factor: gross winners over gross losers. `0` means no winners (the
 * sole "PF 0" reading); `null` is an unbounded factor (winners but no losers,
 * rendered ∞); otherwise the ratio. Sub-1 factors keep 2 significant figures
 * so a small-but-real factor (e.g. 0.0033) doesn't round to 0 and masquerade
 * as "no winners".
 */
export function profitFactor(b: RollupStatsBucket): number | null {
  const grossProfit = Number(b.grossProfit);
  const grossLoss = Number(b.grossLoss);
  if (grossProfit === 0) return 0;
  if (grossLoss === 0) return null;
  const pf = grossProfit / grossLoss;
  return pf < 1 ? Number(pf.toPrecision(2)) : Number(pf.toFixed(2));
}

/**
 * Plain-language label for a symbol's PROVENANCE: where the coin came from. Says nothing about whether discovery may rotate it out — that is the separate pin, and a coin can be pinned whatever its origin.
 *
 * @param source - Stored provenance value; unrecognised values pass through so a future one is never silently mislabelled.
 * @returns Operator-facing label for the source band.
 */
export function sourceLabel(source: string): string {
  if (source === 'auto') return 'Discovery (auto-found)';
  if (source === 'manual') return 'You added it';
  // The binding was re-created by the bot to recover a position it found untracked, so neither the operator nor discovery chose this coin.
  if (source === 'unknown') return 'Recovered by the bot';
  return source;
}
