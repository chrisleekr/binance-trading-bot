// Trader stats derived from a win/loss rollup bucket — win% and profit factor.
// Shared by the trade-archive page's by-exit-reason / by-source bands and the
// Home scoped-KPI strip's by-source band so the two read identically. The
// quotients here are display ratios, not money: the underlying P/L always
// renders from its verbatim decimal string via PnlValue, never these Number
// parses (the same exception the archive panel's `intentShare` documents).

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

/**
 * Compact expectancy figure: sign-prefixed (− is U+2212 to match PnlValue's
 * minus), 2 significant figures for sub-1 magnitudes so a small edge doesn't
 * round to 0, else 2 decimals. Display formatting over a verbatim ratio.
 */
export function formatExpectancy(value: number): string {
  const abs = Math.abs(value);
  const body = abs < 1 ? abs.toPrecision(2) : abs.toFixed(2);
  return `${value < 0 ? '−' : '+'}${body}`;
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

/** Plain-language label for a symbol source: where the coin came from. */
export function sourceLabel(source: string): string {
  if (source === 'auto') return 'Discovery (auto-found)';
  if (source === 'manual') return 'Manual (pinned)';
  return source;
}
