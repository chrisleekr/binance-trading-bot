import { useMemo, useState } from 'react';
import type { BacktestRoundTrip } from '@app/contracts';

import { Button } from '@/shared/components/ui/button';
import {
  formatAmount,
  formatFixed2,
  formatMoneyAmount,
  formatPercent,
  formatPrice,
  signOf,
} from '@/shared/lib/format';
import { formatInstant, humaniseAge } from '@/shared/lib/format-time';

/** Tailwind tone class from a decimal-string's sign. */
const tradeTone = (pnl: string): string => {
  const s = signOf(pnl);
  return s === 'pos' ? 'text-up' : s === 'neg' ? 'text-down' : 'text-fg';
};

/** Tailwind tone class from a number's sign. */
const numTone = (n: number): string => (n > 0 ? 'text-up' : n < 0 ? 'text-down' : 'text-fg');

/** Per-trade table filter: all round-trips, only winners, or only losers. */
type TradeFilter = 'all' | 'wins' | 'losses';

/** Rows-per-page choices for the per-trade table. */
const PAGE_SIZES = [10, 25, 50, 100] as const;

interface ExitReasonRow {
  readonly reason: string;
  readonly trades: number;
  readonly wins: number;
  readonly winRatePct: number;
  readonly totalPnl: number;
  readonly avgReturnPct: number;
}

/**
 * Per-exit-reason rollup: which exits actually make or lose money. Sums are over
 * the per-trade decimal-strings as JS numbers — a display aggregate at ~$200
 * account scale, never fed back into a money decision; the exact per-trade P&L is
 * shown in the table below. Sorted by trade count so the dominant exit leads.
 */
function rollupByExitReason(roundTrips: readonly BacktestRoundTrip[]): ExitReasonRow[] {
  const byReason = new Map<string, { trades: number; wins: number; pnl: number; ret: number }>();
  for (const rt of roundTrips) {
    const r = byReason.get(rt.exitReason) ?? { trades: 0, wins: 0, pnl: 0, ret: 0 };
    r.trades += 1;
    if (signOf(rt.pnlQuote) === 'pos') r.wins += 1;
    r.pnl += Number(rt.pnlQuote);
    r.ret += rt.returnPct;
    byReason.set(rt.exitReason, r);
  }
  return [...byReason.entries()]
    .map(([reason, r]) => ({
      reason,
      trades: r.trades,
      wins: r.wins,
      winRatePct: (r.wins / r.trades) * 100,
      totalPnl: r.pnl,
      avgReturnPct: r.ret / r.trades,
    }))
    .sort((a, b) => b.trades - a.trades || a.reason.localeCompare(b.reason));
}

/** Median + max of a numeric array; 0/0 for empty. */
function holdStats(roundTrips: readonly BacktestRoundTrip[]): { medianMs: number; maxMs: number } {
  if (roundTrips.length === 0) return { medianMs: 0, maxMs: 0 };
  const sorted = roundTrips.map((rt) => rt.durationMs).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : (sorted[mid] ?? 0);
  return { medianMs, maxMs: sorted[sorted.length - 1] ?? 0 };
}

interface BacktestRoundTripsProps {
  readonly roundTrips: readonly BacktestRoundTrip[];
  readonly timeZone: string;
}

/**
 * Closed round-trips drill-down: a per-exit-reason rollup (which exits make or
 * lose money) above a per-trade table. Round-trips pair each reducing sell against
 * the position's average cost, so a grid that stacks several buys before one sell
 * is one row — unlike the raw Fills list. Renders nothing when no position ever
 * closed; the caller shows the Fills table regardless.
 */
export function BacktestRoundTrips({
  roundTrips,
  timeZone,
}: BacktestRoundTripsProps): React.JSX.Element | null {
  const rollup = useMemo(() => rollupByExitReason(roundTrips), [roundTrips]);
  const hold = useMemo(() => holdStats(roundTrips), [roundTrips]);
  const [filter, setFilter] = useState<TradeFilter>('all');
  const [pageSize, setPageSize] = useState<number>(10);
  const [page, setPage] = useState(1);

  // The filter and pagination act on the per-trade table only. The rollup and
  // the win-rate/hold summary stay over the full set, so the run-level read
  // never shifts when the operator narrows the table to wins or losses.
  const filtered = useMemo(() => {
    if (filter === 'all') return roundTrips;
    const want = filter === 'wins' ? 'pos' : 'neg';
    return roundTrips.filter((rt) => signOf(rt.pnlQuote) === want);
  }, [roundTrips, filter]);

  if (roundTrips.length === 0) return null;

  const wins = roundTrips.filter((rt) => signOf(rt.pnlQuote) === 'pos').length;
  const losses = roundTrips.filter((rt) => signOf(rt.pnlQuote) === 'neg').length;
  const winRatePct = (wins / roundTrips.length) * 100;

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(page, pageCount);
  const start = (clampedPage - 1) * pageSize;
  const visible = filtered.slice(start, start + pageSize);

  return (
    <section
      aria-labelledby="bt-roundtrips-h"
      className="space-y-3 rounded-md border border-border bg-bg-elevated p-3"
      data-testid="backtest-round-trips"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="bt-roundtrips-h" className="text-sm font-semibold text-fg">
          Trades ({roundTrips.length})
        </h2>
        <p className="text-xs text-muted-fg" data-testid="backtest-round-trips-summary">
          {formatPercent(winRatePct)} won · typically held{' '}
          {humaniseAge(hold.medianMs, { precision: 'tenths' })} · longest{' '}
          {humaniseAge(hold.maxMs, { precision: 'tenths' })}
        </p>
      </div>

      <p className="text-xs leading-tight text-muted-fg">
        A trade is one buy-to-sell round-trip (a grid that buys several times before selling counts
        once). Use the exit-reason rollup to see which exits actually make money.
      </p>

      {/* Exit-reason rollup — the "which exit loses money" lens. */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm tabular-nums" data-testid="backtest-exit-reason-rollup">
          <thead className="text-left text-xs text-muted-fg">
            <tr>
              <th className="py-1 pr-3">Exit reason</th>
              <th className="py-1 pr-3">Trades</th>
              <th className="py-1 pr-3">Win rate</th>
              <th className="py-1 pr-3">Total P&amp;L</th>
              <th className="py-1 pr-3">Avg return</th>
            </tr>
          </thead>
          <tbody>
            {rollup.map((r) => (
              <tr key={r.reason} className="border-t border-border">
                <td className="py-1 pr-3">{r.reason}</td>
                <td className="py-1 pr-3 font-mono">{r.trades}</td>
                <td className="py-1 pr-3 font-mono">{formatPercent(r.winRatePct)}</td>
                <td className={`py-1 pr-3 font-mono ${numTone(r.totalPnl)}`}>
                  {formatFixed2(r.totalPnl)}
                </td>
                <td className={`py-1 pr-3 font-mono ${numTone(r.avgReturnPct)}`}>
                  {formatPercent(r.avgReturnPct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Per-trade round-trips: filter by outcome, then page through. */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Filter trades by outcome"
          >
            {(
              [
                ['all', `All (${roundTrips.length})`],
                ['wins', `Wins (${wins})`],
                ['losses', `Losses (${losses})`],
              ] as const
            ).map(([key, label]) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={filter === key ? 'default' : 'outline'}
                onClick={() => {
                  setFilter(key);
                  setPage(1);
                }}
                data-testid={`bt-trades-filter-${key}`}
              >
                {label}
              </Button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-fg">
            Rows per page
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-fg"
              data-testid="bt-trades-page-size"
            >
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums" data-testid="backtest-round-trips-table">
            <thead className="text-left text-xs text-muted-fg">
              <tr>
                <th className="py-1 pr-3">Closed</th>
                <th className="py-1 pr-3">Symbol</th>
                <th className="py-1 pr-3">Entry</th>
                <th className="py-1 pr-3">Exit</th>
                <th className="py-1 pr-3">Qty</th>
                <th className="py-1 pr-3">P&amp;L</th>
                <th className="py-1 pr-3">Return</th>
                <th className="py-1 pr-3">Held</th>
                <th className="py-1 pr-3">Exit reason</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((rt, i) => (
                <tr key={`${rt.closeTsMs}-${start + i}`} className="border-t border-border">
                  <td className="py-1 pr-3">{formatInstant(rt.closeTsMs, timeZone)}</td>
                  <td className="py-1 pr-3">{rt.symbol}</td>
                  <td className="py-1 pr-3 font-mono">{formatPrice(rt.entryPrice)}</td>
                  <td className="py-1 pr-3 font-mono">{formatPrice(rt.exitPrice)}</td>
                  <td className="py-1 pr-3 font-mono">{formatAmount(rt.qty)}</td>
                  <td className={`py-1 pr-3 font-mono ${tradeTone(rt.pnlQuote)}`}>
                    {formatMoneyAmount(rt.pnlQuote)}
                  </td>
                  <td className={`py-1 pr-3 font-mono ${numTone(rt.returnPct)}`}>
                    {formatPercent(rt.returnPct)}
                  </td>
                  <td className="py-1 pr-3 font-mono">
                    {humaniseAge(rt.durationMs, { precision: 'tenths' })}
                  </td>
                  <td className="py-1 pr-3">{rt.exitReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-muted-fg" data-testid="bt-trades-range">
            {filtered.length === 0
              ? 'No trades match this filter'
              : `Showing ${start + 1}–${Math.min(start + pageSize, filtered.length)} of ${filtered.length}`}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={clampedPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              data-testid="bt-trades-prev"
            >
              Prev
            </Button>
            <span className="text-muted-fg tabular-nums">
              Page {clampedPage} / {pageCount}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={clampedPage >= pageCount}
              onClick={() => setPage((p) => p + 1)}
              data-testid="bt-trades-next"
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
