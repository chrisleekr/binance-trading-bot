import { decimalAdd, weakestFeeBasis, type EquitySnapshotPoint } from '@app/contracts';

import type { RollupStatsBucket } from './rollup-stats';

/**
 * Largest peak-to-trough decline across a cumulative P/L curve, in quote terms (>= 0).
 *
 * Takes the values rather than the snapshots so a caller that plots a SUBSET of the read can measure the curve it actually drew: a figure folded over points the chart beside it dropped names a give-back the operator cannot find on the line. Invariant under rebasing, since every term is a difference between two values on the same curve.
 *
 * This is a P/L curve, not account NAV, so it is an absolute drawdown (worst give-back from a running high-water mark), not a percentage.
 *
 * @param values - Cumulative net P/L at each plotted instant, in order.
 * @returns The worst give-back, or 0 for an empty series or one that never fell.
 */
export function maxDrawdown(values: readonly number[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/** {@link maxDrawdown} over a whole snapshot read, for the callers that plot every point they fetched. */
export function maxDrawdownQuote(points: readonly EquitySnapshotPoint[] | undefined): number {
  return maxDrawdown((points ?? []).map((p) => Number(p.netPnlQuote)));
}

/** The bucket fields the period rollups (by source / by intent) carry. */
interface MergeableBucket {
  /** The currency this bucket's money is denominated in. The server buckets by `(quoteAsset, dimension)`, so a profile whose quote was changed carries one bucket per currency. */
  readonly quoteAsset: string;
  readonly tradeCount: number;
  /** How many of `tradeCount` carried fee evidence. Every field below it was already summed over those rows alone by the server, so this is the denominator they share. */
  readonly netTradeCount: number;
  /** Recorded result over every row in the bucket. */
  readonly profitSum: string;
  /** Result over the fee-valued rows only, their own fees already subtracted. */
  readonly netProfit: string;
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
 * `netProfit` sums only the buckets that valued something, for the same reason the server's own fold does: adding an unvalued bucket's Recorded result into a net total charges the valued buckets' fees against it.
 *
 * @returns One bucket denominated in `quoteAsset`, with the WEAKEST fee tier any bucket that valued something carried. Zeroed at the strongest tier when no bucket matches: nothing was read, so there is nothing to distrust. `unknown` when buckets matched but none of them valued a row, which is the opposite fact.
 */
export function mergeRollupBuckets(
  buckets: readonly MergeableBucket[],
  quoteAsset: string,
): RollupStatsBucket & {
  readonly netTradeCount: number;
  readonly profitSum: string;
  readonly netProfit: string;
} {
  const quote = quoteAsset.toUpperCase();
  let tradeCount = 0;
  let netTradeCount = 0;
  let profitSum = '0';
  let netProfit = '0';
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
    profitSum = decimalAdd(profitSum, b.profitSum);
    // A bucket that valued nothing reports the weakest tier and zeroed money, so folding it in would drag the merged tier to `unknown` and blank the statistics of every sibling that did value its rows, which is the whole defect this fold exists downstream of. It has already contributed its cycles to `tradeCount`, which is all it evidences.
    if (b.netTradeCount === 0) continue;
    netTradeCount += b.netTradeCount;
    netProfit = decimalAdd(netProfit, b.netProfit);
    wins += b.wins;
    losses += b.losses;
    grossProfit = decimalAdd(grossProfit, b.grossProfit);
    grossLoss = decimalAdd(grossLoss, b.grossLoss);
    totalFees = decimalAdd(totalFees, b.totalFees);
    feeBasis = weakestFeeBasis(feeBasis, b.feeBasis ?? 'unknown');
  }
  return {
    tradeCount,
    netTradeCount,
    profitSum,
    netProfit,
    wins,
    losses,
    grossProfit,
    grossLoss,
    totalFees,
    // Buckets matched but none valued a row: report that nothing could be trusted rather than the untouched `exact` seed, which would certify a zero. With no bucket matching at all, the seed stands, because then there was nothing to read.
    feeBasis: tradeCount > 0 && netTradeCount === 0 ? 'unknown' : feeBasis,
  };
}
