// "Where the edge is": one period rollup rendered as a sortable grid from `md` up and as the same compact two-line cards below it.
//
// Which of the two renders is a pure CSS decision (`md:hidden` / `hidden md:block`), never `matchMedia`: a JS breakpoint re-renders the whole list on every resize and disagrees with the CSS one during hydration. Both are in the DOM at once, so their testids are disjoint and neither is a prefix of the other.

import { useState } from 'react';

import { PnlValue, UnavailablePnl } from '@/shared/components/pnl-value';
import { RollupStatsLine } from '@/shared/components/rollup-stats-line';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table';
import { formatHoldDuration, formatPercent } from '@/shared/lib/format';
import { expectancy, formatExpectancy, winPct } from '@/shared/lib/rollup-stats';
import {
  bucketPnl,
  unavailablePnlGlyph,
  unavailablePnlLabel,
  type BucketWithShare,
  type RollupBucketPnlFields,
} from '@/features/profile/lib/archive-view-model';

import type { PnlBasis } from '@/shared/hooks/use-pnl-basis';
import type { RollupStatsBucket } from '@/shared/lib/rollup-stats';

/** One row of the grid: a rollup bucket, its share of the coin's P/L, and the label and filter value of whatever dimension it was grouped by. */
export type EdgeBucket = BucketWithShare<RollupBucketPnlFields & RollupStatsBucket> & {
  readonly avgHoldMs?: number | null;
};

/** Which column the operator ordered by. `null` keeps the server's own `(quote, dimension)` order, which is stable across refetches and is what the grid opens on. */
type SortKey = 'trades' | 'win' | 'net' | 'exp' | 'hold' | null;

/**
 * The value a sort key reads off a bucket.
 *
 * The P/L column reads the SAME projection the cell renders — under the Recorded basis the cell shows `profitSum`, so ordering by `netProfit` there would rank the rows by a number the column never displays.
 *
 * @param b - The bucket being ranked.
 * @param key - Which column is ordering the grid.
 * @param basis - The operator's P/L basis, which decides which of the bucket's two amounts the Net column is showing and therefore ranking.
 * @returns The comparable reading, or null where this bucket has no reading for that column — which is not a zero, and sorts last in either direction.
 */
function sortValue(b: EdgeBucket, key: Exclude<SortKey, null>, basis: PnlBasis): number | null {
  if (key === 'trades') return b.tradeCount;
  if (key === 'win') return b.netTradeCount === 0 ? null : winPct(b);
  if (key === 'net') {
    const pnl = bucketPnl(b, basis);
    return pnl === null ? null : Number(pnl.pnl);
  }
  if (key === 'exp') return b.netTradeCount === 0 ? null : expectancy(b);
  return b.avgHoldMs ?? null;
}

/**
 * Order the buckets for display.
 *
 * Copies before sorting: `rows` is the query's own array, and sorting it in place would mutate cached data that other renders read.
 *
 * @param rows - The period's buckets in the server's order.
 * @param key - The column ordering them, or null to leave the server's order alone — which is what the grid opens on, and is stable across refetches.
 * @param desc - Whether the biggest reading comes first. It flips the KEY comparison only: the unreadable-last rule is not a value, so it does not move with the direction, and a bucket with no reading stays at the bottom under both.
 * @param basis - Passed through to {@link sortValue}, which needs it to know which amount the Net column ranks.
 * @returns A new array in the requested order.
 */
function sortRows<B extends EdgeBucket>(
  rows: readonly B[],
  key: SortKey,
  desc: boolean,
  basis: PnlBasis,
): B[] {
  if (key === null) return [...rows];
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key, basis);
    const bv = sortValue(b, key, basis);
    if (av === null && bv === null) return 0;
    // Unreadable last under both directions: it is not a small value, it is no value.
    if (av === null) return 1;
    if (bv === null) return -1;
    return desc ? bv - av : av - bv;
  });
}

const COLUMNS: readonly { key: Exclude<SortKey, null>; label: string; hint: string }[] = [
  { key: 'trades', label: 'Trades', hint: 'Closed cycles in this bucket' },
  { key: 'win', label: 'Win%', hint: 'Share that finished ahead after commission' },
  { key: 'net', label: 'Net', hint: 'What the bucket made on the selected basis' },
  { key: 'exp', label: 'Exp/trade', hint: 'What an average cycle here was worth' },
  { key: 'hold', label: 'Avg hold', hint: 'How long a cycle here was held' },
];

/**
 * The withheld amount marker, identical in both renders so one missing fee reads the same way at every width.
 *
 * @returns The `net n/a` marker with the accessible description naming the fee fault, which is what distinguishes it from the un-costed `n/a` a screen reader would otherwise hear identically.
 */
function withheld(): React.JSX.Element {
  return (
    <UnavailablePnl glyph={unavailablePnlGlyph('fees')} description={unavailablePnlLabel('fees')} />
  );
}

/**
 * The share cell, which is withheld when this bucket could value no row: it has an unknown contribution, not a zero one, and `0% of P/L` would state the second.
 *
 * Module-level because `react/no-unstable-nested-components` is armed: a component declared inside `EdgeGrid`'s render body is a new type on every render, so React remounts its subtree.
 *
 * @param bucket - The bucket whose share is being stated; a null `share` is what marks it unvalued, and `multiQuote` says whether the coin has to be named for the figure to mean anything.
 * @param testId - Stamped on the cell so the two renders' shares can be read apart — the cards and the table both mount, always.
 * @returns The share, or the withheld marker naming the fee fault behind it.
 */
function ShareCell({
  bucket,
  testId,
}: {
  readonly bucket: EdgeBucket;
  readonly testId: string;
}): React.JSX.Element {
  if (bucket.share === null) {
    return (
      <span data-testid={testId}>
        <UnavailablePnl
          glyph={unavailablePnlGlyph('fees')}
          description={`Share of P/L unavailable, fee evidence missing for every cycle in this ${bucket.quoteAsset} bucket`}
        />
      </span>
    );
  }
  // The coin is named only when it is ambiguous. Shares are apportioned to 100 WITHIN each coin, so a period spanning two renders two pools in one list and the percentages add to 200 unless each says which pool it belongs to.
  return (
    <span className="text-[11px] text-muted-fg tabular-nums" data-testid={testId}>
      {bucket.multiQuote
        ? `${bucket.share}% of ${bucket.quoteAsset} P/L`
        : `${bucket.share}% of P/L`}
    </span>
  );
}

/**
 * The by-exit-reason / by-source breakdown, sortable, with each row a way into the ledger below.
 *
 * @param dimension - Which grouping this grid renders; only used to key testids and the filter it emits, so the two grids on one page never collide.
 * @param title - Section heading.
 * @param rows - The period's buckets, already decorated with their share of the coin's P/L.
 * @param basis - Which P/L the operator asked to see; selects the Net column's amount.
 * @param labelOf - Plain-language label for a bucket's dimension value.
 * @param valueOf - The bucket's dimension value, which is what a row hands back when it is chosen as a ledger filter.
 * @param onSelect - Called with that value when a row is activated, so the ledger below narrows to it.
 * @returns The grid at `md` and up, the cards below it, or nothing when the period holds no buckets.
 */
export function EdgeGrid<B extends EdgeBucket, V extends string>({
  dimension,
  title,
  rows,
  basis,
  labelOf,
  valueOf,
  onSelect,
}: {
  readonly dimension: 'intent' | 'source';
  readonly title: string;
  readonly rows: readonly B[];
  readonly basis: PnlBasis;
  readonly labelOf: (bucket: B) => string;
  readonly valueOf: (bucket: B) => V;
  readonly onSelect: (value: V) => void;
}): React.JSX.Element | null {
  const [sort, setSort] = useState<SortKey>(null);
  const [desc, setDesc] = useState(true);
  if (rows.length === 0) return null;
  const ordered = sortRows(rows, sort, desc, basis);

  const toggle = (key: Exclude<SortKey, null>): void => {
    if (sort === key) setDesc((d) => !d);
    else {
      setSort(key);
      setDesc(true);
    }
  };

  return (
    <section
      className="space-y-2 rounded-md border border-border p-3"
      data-testid={`archive-by-${dimension}`}
      aria-label={title}
    >
      <p className="text-sm font-medium text-fg">{title}</p>

      {/* Below md the six columns become a horizontal scroll strip, so the same buckets render as the two-line cards the trade list already uses at this width. */}
      <ul className="space-y-2 md:hidden">
        {ordered.map((b) => {
          const pnl = bucketPnl(b, basis);
          const value = valueOf(b);
          return (
            <li key={`${b.quoteAsset}-${value}`}>
              <button
                type="button"
                onClick={() => onSelect(value)}
                data-testid={`edge-card-${dimension}-${b.quoteAsset}-${value}`}
                className="flex min-h-11 w-full flex-col gap-0.5 rounded-md p-1 text-left hover:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
              >
                <span className="flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 flex-1 truncate text-muted-fg">{labelOf(b)}</span>
                  <span className="w-24 text-right font-mono tabular-nums">
                    {pnl === null ? withheld() : <PnlValue value={pnl.pnl} unit={b.quoteAsset} />}
                  </span>
                </span>
                <span className="flex items-center justify-between gap-3">
                  <RollupStatsLine bucket={b} />
                  <ShareCell
                    bucket={b}
                    testId={`edge-card-share-${dimension}-${b.quoteAsset}-${value}`}
                  />
                </span>
                <span className="text-[11px] text-muted-fg">
                  held {formatHoldDuration(b.avgHoldMs)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="hidden rounded-md border border-border md:block">
        <Table className="text-xs" data-testid={`edge-table-${dimension}`}>
          <TableHeader>
            <TableRow>
              <TableHead>{dimension === 'intent' ? 'Exit reason' : 'Source'}</TableHead>
              {COLUMNS.map((c) => (
                <TableHead
                  key={c.key}
                  className="text-right"
                  aria-sort={sort === c.key ? (desc ? 'descending' : 'ascending') : 'none'}
                >
                  <button
                    type="button"
                    onClick={() => toggle(c.key)}
                    title={c.hint}
                    data-testid={`edge-sort-${dimension}-${c.key}`}
                    className="min-h-11 w-full text-right hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                  >
                    {c.label}
                    {sort === c.key ? (desc ? ' ▼' : ' ▲') : ''}
                  </button>
                </TableHead>
              ))}
              <TableHead className="text-right">Share</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ordered.map((b) => {
              const pnl = bucketPnl(b, basis);
              const value = valueOf(b);
              const exp = b.netTradeCount === 0 ? null : expectancy(b);
              return (
                <TableRow
                  key={`${b.quoteAsset}-${value}`}
                  data-testid={`edge-${dimension}-${b.quoteAsset}-${value}`}
                >
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => onSelect(value)}
                      data-testid={`edge-open-${dimension}-${b.quoteAsset}-${value}`}
                      className="min-h-11 text-left text-muted-fg hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                    >
                      {labelOf(b)} ›
                    </button>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {b.tradeCount}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {b.netTradeCount === 0 ? withheld() : formatPercent(winPct(b))}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {pnl === null ? (
                      withheld()
                    ) : (
                      <>
                        <PnlValue value={pnl.pnl} unit={b.quoteAsset} />
                        {pnl.excluded > 0 ? (
                          <span
                            className="block text-[11px] text-muted-fg"
                            data-testid={`edge-partial-${dimension}-${b.quoteAsset}-${value}`}
                          >
                            {pnl.covered} of {pnl.covered + pnl.excluded} cycles
                          </span>
                        ) : null}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {exp === null ? withheld() : formatExpectancy(exp)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatHoldDuration(b.avgHoldMs)}
                  </TableCell>
                  <TableCell className="text-right">
                    <ShareCell
                      bucket={b}
                      testId={`edge-share-${dimension}-${b.quoteAsset}-${value}`}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
