import type { EquitySnapshotPoint } from '@app/contracts';

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
  readonly tradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly grossProfit: string;
  readonly grossLoss: string;
  readonly totalFees: string;
}

/**
 * Sum per-source (or per-intent) rollup buckets into one overall bucket, so the
 * scorecard's headline win-rate / profit-factor / expectancy cover all of a
 * period's closed trades rather than one partition. Money fields are summed as
 * `number` — display only; the scorecard never feeds order math.
 */
export function mergeRollupBuckets(buckets: readonly MergeableBucket[]): RollupStatsBucket {
  let tradeCount = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let totalFees = 0;
  for (const b of buckets) {
    tradeCount += b.tradeCount;
    wins += b.wins;
    losses += b.losses;
    grossProfit += Number(b.grossProfit);
    grossLoss += Number(b.grossLoss);
    totalFees += Number(b.totalFees);
  }
  return {
    tradeCount,
    wins,
    losses,
    grossProfit: String(grossProfit),
    grossLoss: String(grossLoss),
    totalFees: String(totalFees),
  };
}
