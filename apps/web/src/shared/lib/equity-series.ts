// The fold behind the "profit vs holding" curve, shared by the Home card and the History page.
//
// Extracted from the Home card rather than left there and imported across features: two surfaces plot the same window, and two copies of an anchor-and-rebase fold is exactly how they come to disagree about what the operator made.

import {
  weakestFeeBasis,
  type BenchmarkMode,
  type EquitySnapshotPoint,
  type FeeBasis,
} from '@app/contracts';

/** One plotted instant: the profile's cumulative net P/L and the benchmark's, both rebased to zero at the window's anchor. */
export interface ChartPoint {
  tsMs: number;
  netPnl: number;
  hold: number;
}

/**
 * Equal-weight basket return from the anchor's prices to a point's prices, over the symbols present in BOTH maps.
 *
 * The intersection is the point: a coin that fully exited the held set has no price at this point and would otherwise be counted at its anchor price forever, which reads as a coin held flat rather than one that is gone. Equal-weight, because the alternative is weighting by a position size that changed across the window and would make the counterfactual depend on the very trading it is meant to be a control for.
 *
 * @param anchor - Symbol-to-price map captured at the window's base point; the denominators.
 * @param point - The same map at the instant being plotted; the numerators.
 * @returns The mean per-symbol return as a fraction (0.05 = up 5%), or null when no symbol appears in both maps with a usable base — which the caller reads as "hold the line flat", never as a zero return.
 */
const basketReturn = (
  anchor: Record<string, string> | null | undefined,
  point: Record<string, string> | null | undefined,
): number | null => {
  if (!anchor || !point) return null;
  let acc = 0;
  let n = 0;
  for (const [sym, base] of Object.entries(anchor)) {
    const b = Number(base);
    const cur = point[sym];
    if (cur === undefined || b <= 0) continue;
    acc += Number(cur) / b - 1;
    n += 1;
  }
  return n === 0 ? null : acc / n;
};

/**
 * Derive the chart series: what the profile actually made, against what holding the benchmark would have made over the same window.
 *
 * `netPnl` is the profile's own cumulative net-of-fee profit. `hold` is the honest counterfactual: had the capital first deployed been put into the chosen benchmark instead and held, this is the P/L it would have made. The benchmark is BTC or an equal-weight basket of the profile's own held symbols — the latter measures skill against the coins actually picked, not just BTC's beta.
 *
 * Both lines anchor to the first point where capital was deployed, not to the worker's first boot, so the comparison starts when money was put in rather than when the process started. When nothing was ever deployed the hold line stays flat at 0.
 *
 * `feeBasis` is the weakest tier any PLOTTED point carries, because the green line is one claim about the whole window and a reader has to be told about its worst evidence. It is folded here rather than filtered server-side: a snapshot's realised leg is an all-time cumulative fold whose tier no forward path lifts, so withholding the weak points would empty the card permanently instead of deferring it. Each point's tier is frozen at capture, so reconciling fees repairs the archive without clearing this marker for points already recorded — it stands until they age out of the window. An empty window is `exact` — there is nothing there to distrust.
 *
 * @param points - The window's snapshots, oldest first, or undefined while the read is in flight.
 * @param mode - Which counterfactual the orange line is: BTC, or the profile's own basket.
 * @returns `series` rebased to zero at the anchor and covering the anchor onwards only; `holdWindowPct` the benchmark's own move across the window, or null where no point could be compared; `latestNetPnl` the raw (un-rebased) cumulative figure at the last point; and `feeBasis`, the weakest tier among the points actually plotted.
 */
export const toSeries = (
  points: readonly EquitySnapshotPoint[] | undefined,
  mode: BenchmarkMode,
): {
  series: ChartPoint[];
  holdWindowPct: number | null;
  latestNetPnl: number | null;
  feeBasis: FeeBasis;
} => {
  if (!points || points.length === 0) {
    return { series: [], holdWindowPct: null, latestNetPnl: null, feeBasis: 'exact' };
  }
  const deployedIdx = points.findIndex((p) => Number(p.positionCostQuote) > 0);
  const startIdx = deployedIdx === -1 ? 0 : deployedIdx;
  const anchor = points[startIdx];
  const last = points.at(-1);
  if (!anchor || !last)
    return { series: [], holdWindowPct: null, latestNetPnl: null, feeBasis: 'exact' };
  const windowed = points.slice(startIdx);
  const cost0 = Number(anchor.positionCostQuote);
  const netPnl0 = Number(anchor.netPnlQuote);
  const btc0 = Number(anchor.benchmarkPriceQuote);
  // The basket's constituents are the prices captured at its base point. Use the
  // first windowed point that actually has prices (normally the anchor), so a
  // transient missing-ticker at the deploy snapshot does not permanently shrink
  // the basket for the whole window.
  const basketBase = windowed.find(
    (p) => p.benchmarkPrices && Object.keys(p.benchmarkPrices).length > 0,
  )?.benchmarkPrices;
  const holdReturn = (p: EquitySnapshotPoint): number | null => {
    if (mode === 'basket') return basketReturn(basketBase, p.benchmarkPrices);
    const btc = Number(p.benchmarkPriceQuote);
    return btc0 > 0 && btc > 0 ? btc / btc0 - 1 : null;
  };
  const series = windowed.map((p): ChartPoint => {
    const r = holdReturn(p);
    return {
      tsMs: new Date(p.capturedAt).getTime(),
      netPnl: Number(p.netPnlQuote) - netPnl0,
      hold: r === null ? 0 : cost0 * r,
    };
  });
  const lastReturn = holdReturn(last);
  const holdWindowPct = lastReturn === null ? null : lastReturn * 100;
  const feeBasis = windowed.reduce<FeeBasis>(
    // `?? 'unknown'` rather than a bare read: the tier is defaulted at the contract boundary, but a point that never went through it leaves it undefined, and reading that silence as proof is the direction this whole tier exists to close.
    (weakest, p) => weakestFeeBasis(weakest, p.feeBasis ?? 'unknown'),
    'exact',
  );
  return { series, holdWindowPct, latestNetPnl: Number(last.netPnlQuote), feeBasis };
};
