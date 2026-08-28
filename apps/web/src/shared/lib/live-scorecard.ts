import { decimalAdd, weakestFeeBasis, type EquitySnapshotPoint } from '@app/contracts';

import type { RollupStatsBucket } from './rollup-stats';

/**
 * Largest peak-to-trough decline of cumulative net P/L across the series, in
 * quote terms (>= 0). This is a P/L curve, not account NAV, so it is an absolute
 * drawdown (worst give-back from a running high-water mark), not a percentage.
 */
export function maxDrawdownQuote(points: readonly EquitySnapshotPoint[] | undefined): number {
  if (!points || points.length === 0) return 0;
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of points) {
    const v = Number(p.netPnlQuote);
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/** The bucket fields the period rollups (by source / by intent) carry. */
interface MergeableBucket {
  /** The currency this bucket's money is denominated in. The server buckets by `(quoteAsset, dimension)`, so a profile whose quote was changed carries one bucket per currency. */
  readonly quoteAsset: string;
  readonly tradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly grossProfit: string;
  readonly grossLoss: string;
  readonly totalFees: string;
  readonly feeBasis?: string;
}

/**
 * Sum per-source (or per-intent) rollup buckets into one overall bucket, so the scorecard's headline win-rate / profit-factor / expectancy cover all of a period's closed trades rather than one partition.
 *
 * Money is summed as decimal STRINGS, not through `Number`. Not a precision nicety: the sums are re-stringified and handed to `PnlValue`, which renders whatever string it is given, and `String(1e-7)` is the literal `1e-7` — an exponent landing in a column of ordinary decimals on the operator's scorecard. The repo's DOM gate cannot catch this one, because it flags a raw decimal reaching the DOM and not one laundered through `Number` first. `decimalAdd` returns plain notation for every magnitude, which is the same reason the wire encoder uses `toFixed`.
 *
 * `quoteAsset` is required rather than defaulted. The server buckets by `(quoteAsset, dimension)` and these consumers ask for the all-time window, so a profile whose quote was changed after it had closed cycles returns buckets in two currencies. Summing them would add a BTC figure to a USDT one and label the result with the profile's current quote — the same defect the server aggregates were just fixed for, and one that shows no error.
 *
 * @param buckets - Period rollup buckets, possibly spanning several currencies.
 * @param quoteAsset - The currency to count in; buckets in any other are dropped. Compared case-folded because `profiles.quoteAsset` may be stored lower or mixed case while the archive carries Binance's upper casing.
 * @returns One bucket denominated in `quoteAsset`, with the WEAKEST fee tier any counted bucket carried. Zeroed at the strongest tier when no bucket matches: nothing was read, so there is nothing to distrust.
 */
export function mergeRollupBuckets(
  buckets: readonly MergeableBucket[],
  quoteAsset: string,
): RollupStatsBucket {
  const quote = quoteAsset.toUpperCase();
  let tradeCount = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = '0';
  let grossLoss = '0';
  let totalFees = '0';
  // Seeded at the strongest tier so the fold below can only ever weaken it, matching the contract's rollup fold and the SQL aggregate.
  let feeBasis = 'exact';
  for (const b of buckets) {
    if (b.quoteAsset.toUpperCase() !== quote) continue;
    tradeCount += b.tradeCount;
    wins += b.wins;
    losses += b.losses;
    grossProfit = decimalAdd(grossProfit, b.grossProfit);
    grossLoss = decimalAdd(grossLoss, b.grossLoss);
    totalFees = decimalAdd(totalFees, b.totalFees);
    feeBasis = weakestFeeBasis(feeBasis, b.feeBasis ?? 'unknown');
  }
  return {
    tradeCount,
    wins,
    losses,
    grossProfit,
    grossLoss,
    totalFees,
    feeBasis,
  };
}
