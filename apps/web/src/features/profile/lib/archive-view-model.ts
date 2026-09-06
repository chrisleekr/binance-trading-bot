// Resolves the Net/Recorded basis once per displayed value, so no component can pair a Net amount with a Recorded percentage. The persisted basis token remains `gross` for cached-client compatibility.
//
// `apps/web` is barred from decimal.js (lint-enforced), and that is not an oversight to repair here. Money stays a VERBATIM decimal string end to end and renders through `PnlValue`; only DISPLAY RATIOS — a percentage, a share of a total — go through plain `Number`, because a ratio is already a lossy summary and never becomes an order quantity. The same split is documented on `shared/lib/rollup-stats.ts`.

import { holdMsBetween } from '@app/contracts';

import type { PnlBasis } from '@/shared/hooks/use-pnl-basis';

/** The fields of an archive row that a basis choice selects between, plus the two facts that can make a Net figure unusable: an un-costed sell, and a commission nobody accounted for. */
export interface ArchiveRowPnlFields {
  readonly totalBuyQuote: string;
  readonly profit: string;
  readonly netProfit: string;
  readonly missingCostBasis: number;
  readonly feeBasis: string;
}

/** The fields of a rollup bucket that a basis choice selects between, plus the two counts saying how many rows each basis was summed over. `profitSum` is the Recorded cost-basis sum over every row; `netProfit` applies the additional commission adjustment and spans the `netTradeCount` rows whose fees were known. */
export interface RollupBucketPnlFields {
  readonly quoteAsset: string;
  readonly profitSum: string;
  readonly netProfit: string;
  readonly tradeCount: number;
  readonly netTradeCount: number;
  readonly feeBasis: string;
}

/** A P/L figure with the rows it covers. `excluded > 0` means the reader is looking at a partial total and has to be told so on the same line. */
export interface BucketPnl {
  readonly pnl: string;
  readonly covered: number;
  readonly excluded: number;
}

/**
 * One row's P/L resolved onto a basis. A discriminated union rather than nullable fields: an un-costed row has no amount AND no percentage, and pairing them in one variant makes it impossible to render one without the other.
 */
export type RowPnl =
  | { readonly available: false; readonly reason: 'cost-basis' | 'fees' }
  | {
      readonly available: true;
      readonly pnl: string;
      readonly pnlPercent: string;
      /** True when this row's Net figure includes a commission reconstructed from a rate table rather than the charge Binance reported. Carried on the result rather than re-read from the row so the renderer cannot resolve the tier by hand and drift from the rule that decided availability. */
      readonly estimated: boolean;
    };

/** A rollup bucket carrying its own share of the quote coin's closing P/L. Decorated rather than a parallel array so a share cannot drift onto the wrong bucket. */
export type BucketWithShare<T> = T & {
  readonly share: number | null;
  /** Whether the bucket list this bucket came from spans more than one quote coin, i.e. whether `share` is a portion of a pool the reader has to be told the name of. A property of the whole list, copied onto every bucket so a render site cannot answer it from the one bucket it happens to be holding. */
  readonly multiQuote: boolean;
};

/** Parse a decimal string as a display magnitude. A malformed or infinite value contributes nothing rather than poisoning a whole group's total with NaN. */
function absMagnitude(value: string): number {
  const n = Math.abs(Number(value));
  return Number.isFinite(n) ? n : 0;
}

/**
 * A row's P/L amount and percentage on one basis, or the unavailable marker.
 *
 * Unavailable when any sell lacks cost basis, or when Net was requested on a row with a charge missing outright. The percentage is derived from the same amount the caller renders. A zero cost basis yields `'0'`, never NaN or Infinity.
 *
 * @param row - The archive row's basis-selectable P/L fields and its un-costed-sell count.
 * @param basis - Which P/L the operator asked to see: Net, or the legacy `gross` token displayed as Recorded.
 * @returns The unavailable marker, or the amount as a verbatim decimal string plus its percentage as a decimal string.
 */
export function rowPnl(row: ArchiveRowPnlFields, basis: PnlBasis): RowPnl {
  if (row.missingCostBasis > 0) return { available: false, reason: 'cost-basis' };
  // `unknown` only. An `estimated` Net figure is a real number reconstructed from a real charge, so withholding it would hide a usable answer; it comes back flagged so the row can mark it. `unknown` means a charge is missing from the total, which makes the figure wrong in a known direction rather than merely imprecise.
  if (basis === 'net' && row.feeBasis === 'unknown') return { available: false, reason: 'fees' };
  // Only Net subtracts fees, so only Net can be an estimate; the Recorded basis is the same number at every tier.
  const estimated = basis === 'net' && row.feeBasis === 'estimated';
  const pnl = basis === 'net' ? row.netProfit : row.profit;
  const cost = Number(row.totalBuyQuote);
  const amount = Number(pnl);
  if (!Number.isFinite(cost) || cost === 0 || !Number.isFinite(amount)) {
    return { available: true, pnl, pnlPercent: '0', estimated };
  }
  return { available: true, pnl, pnlPercent: String((amount / cost) * 100), estimated };
}

/**
 * The P/L amount a rollup bucket shows on one basis, with the row count it was summed over.
 *
 * It exists so the bands cannot resolve the basis by hand and drift from the rows the way the percentage did, and it now carries the denominator for the same reason: a partial total whose coverage is stated somewhere else is one edit away from being read as covering everything.
 *
 * Net is withheld only when NOTHING in the bucket could be valued. A bucket holding one unvalued row among fifty reports the forty-nine-row figure and says so: a partial answer with a stated denominator is strictly more informative than `n/a`, and, unlike a silently partial total, cannot be misread as complete. The old rule withheld the whole answer to avoid disclosing a per-trade uncertainty of a few cents.
 *
 * @param bucket - The bucket's basis-selectable P/L sums and its two row counts.
 * @param basis - Which P/L the operator asked to see: Net, or the legacy `gross` token displayed as Recorded.
 * @returns The amount as a verbatim decimal string with the rows it covers and the rows it leaves out, or null when the Net basis has no valued row to sum.
 */
export function bucketPnl(bucket: RollupBucketPnlFields, basis: PnlBasis): BucketPnl | null {
  // Recorded needs no fee evidence, so it always covers the whole bucket and can never exclude a row.
  if (basis !== 'net') {
    return { pnl: bucket.profitSum, covered: bucket.tradeCount, excluded: 0 };
  }
  if (bucket.netTradeCount === 0) return null;
  return {
    pnl: bucket.netProfit,
    covered: bucket.netTradeCount,
    excluded: bucket.tradeCount - bucket.netTradeCount,
  };
}

/**
 * Each bucket's whole-number share of all closing P/L for ITS quote coin, on the given basis.
 *
 * Losers and winners both count toward the denominator (absolute value), so the shares read as "how much of the action ran through this exit reason" rather than letting a loss cancel a win into a meaningless total. Shares are apportioned by largest remainder within each quote coin: rounding each bucket independently makes the group total 99 or 101, and a set of parts that does not add up to the whole invites the operator to hunt for the missing percent. A quote coin whose absolute total is zero gets zeroes, not NaN. Ties on the fractional remainder go to the earlier bucket, so the output is stable for a stable input order.
 *
 * @param buckets - The rollup buckets to decorate, in render order; grouping is by their `quoteAsset`.
 * @param basis - Which P/L the shares are a portion of: Net, or the legacy `gross` token displayed as Recorded.
 * @returns The same buckets in the same order, each carrying a whole-number share (or null when the bucket itself could value no row, so its contribution is unknown rather than zero) and the list-wide `multiQuote` flag.
 */
export function sharesOfPnl<T extends RollupBucketPnlFields>(
  buckets: readonly T[],
  basis: PnlBasis,
): readonly BucketWithShare<T>[] {
  const shares = new Array<number | null>(buckets.length).fill(0);
  const quoteAssets = new Set(buckets.map((b) => b.quoteAsset));

  for (const quoteAsset of quoteAssets) {
    // One unvalued row among a group's siblings no longer costs the whole group its shares; the magnitudes below come from `bucketPnl`, so each bucket contributes exactly the rows it could value. A group that valued nothing yields no shares at all, because then there is no pool to take a portion of — which falls out of the per-bucket withholding below rather than needing its own gate.
    const group: { index: number; magnitude: number }[] = [];
    buckets.forEach((b, index) => {
      if (b.quoteAsset !== quoteAsset) return;
      const pnl = bucketPnl(b, basis);
      // A bucket that valued nothing is withheld outright rather than coerced to a zero magnitude. Coercing it apportioned it 0% and rendered "0% of P/L", which is a positive claim that this exit reason contributed nothing — the opposite of "nobody knows what it contributed". It stays out of the pool for the same reason: it has no known magnitude to be a share of.
      if (pnl === null) {
        shares[index] = null;
        return;
      }
      group.push({ index, magnitude: absMagnitude(pnl.pnl) });
    });
    const total = group.reduce((sum, g) => sum + g.magnitude, 0);
    if (total === 0) continue;

    const exact = group.map((g) => (g.magnitude / total) * 100);
    const floors = exact.map((e) => Math.floor(e));
    let remaining = 100 - floors.reduce((sum, f) => sum + f, 0);
    // Hand the leftover points to the biggest fractional remainders. The index tiebreak keeps a tie resolving the same way every render.
    const order = exact
      .map((e, i) => ({ i, remainder: e - Math.floor(e) }))
      .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
    // Every `?? 0` below is a noUncheckedIndexedAccess appeasement, not a real case: `floors` is `exact.map` and `order` carries only `exact`'s own indices, and `shares` is pre-filled to `buckets.length`, so no lookup here can miss.
    for (const { i } of order) {
      if (remaining <= 0) break;
      floors[i] = (floors[i] ?? 0) + 1;
      remaining -= 1;
    }
    group.forEach((g, i) => {
      shares[g.index] = floors[i] ?? 0;
    });
  }

  // Every bucket gets the same answer, including the coins that are unambiguous on their own. What confuses the reader is the LIST holding two pools that each total 100, so a single-coin bucket sitting in that list is one half of the problem, not an innocent bystander.
  const multiQuote = quoteAssets.size > 1;
  return buckets.map((b, index) => ({ ...b, share: shares[index] ?? null, multiQuote }));
}

/**
 * Operator-facing wording for a P/L that is unavailable, keyed by which fault caused it.
 *
 * The two faults are different problems with different remedies — a missing cost basis is unrecoverable history, incomplete fee evidence is a Reconcile-fees away — so the wording is the operator's only full statement of which one they hit. Shared because the archive renders the same fault on five surfaces (desktop table row, phone card, the detail sheet that card opens, and each summary band's amount) and they must not drift into naming different faults for one fault.
 *
 * @param reason - Why the number was withheld: no cost basis for at least one sell, or Net requested without complete fee evidence. Rows take it from {@link rowPnl}; the summary bands pass `'fees'`, the only fault {@link bucketPnl} can withhold on.
 * @returns The accessible name of the marker rendered in place of the amount, which a screen reader announces instead of the glyph's letters.
 */
export function unavailablePnlLabel(reason: 'cost-basis' | 'fees'): string {
  return reason === 'fees' ? 'Net P/L unavailable' : 'P/L unavailable';
}

/**
 * The visible mark for the same value, keyed by the same fault.
 *
 * A sighted operator on a phone has no way to reach an accessible name: `title` is hover-only, and a long-press raises the OS text menu rather than a tooltip. So the fault distinction has to survive in the glyph itself, or the difference between "nobody knows what this coin cost" and "the fee evidence is still incomplete" is invisible to the reader most likely to be looking. `net n/a` marks the second, because that fault withholds only the net figure while the recorded one and the raw fees stay on the row.
 *
 * @param reason - Why the number was withheld, the same discriminant {@link unavailablePnlLabel} reads.
 * @returns The short mark to render in the numeric column, sized to sit beside the amounts rather than displace them.
 */
export function unavailablePnlGlyph(reason: 'cost-basis' | 'fees'): string {
  return reason === 'fees' ? 'net n/a' : 'n/a';
}

/**
 * How long a cycle was held, from the first buy that filled to the sell that closed it.
 *
 * The span rule itself lives in `@app/contracts` and is shared with the API's sort key and the rollup's average hold: a copy here once dropped the negative-span guard, so a row whose two stamps cannot both belong to it sorted first under an ascending hold sort and rendered as `1m`, the shortest hold `formatHoldDuration` can express.
 *
 * @param row - Any archive row carrying the two derived stamps.
 * @returns Elapsed milliseconds, or null when the row cannot prove its hold.
 */
export const holdMsOf = (row: {
  readonly entryAt: string | null;
  readonly exitAt: string | null;
}): number | null => holdMsBetween(row.entryAt, row.exitAt);
