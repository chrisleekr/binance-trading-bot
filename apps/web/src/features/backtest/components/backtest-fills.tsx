import { useMemo, useState } from 'react';
import type { BacktestTrade } from '@app/contracts';

import { Button } from '@/shared/components/ui/button';
import { formatAmount, formatMoneyAmount, formatPrice } from '@/shared/lib/format';
import { formatInstant } from '@/shared/lib/format-time';
import { Select } from '@/shared/components/ui/select';

/** Fills table filter: every fill, only buys, or only sells. */
type FillFilter = 'all' | 'buys' | 'sells';

/** Rows-per-page choices for the fills table. */
const PAGE_SIZES = [10, 25, 50, 100] as const;

interface BacktestFillsProps {
  readonly trades: readonly BacktestTrade[];
  readonly timeZone: string;
}

/**
 * Raw fills list: one row per order fill (a grid that buys several times before
 * selling is several rows here, unlike the round-trips table). Filter by side and
 * page through so a long run stays scannable.
 */
export function BacktestFills({ trades, timeZone }: BacktestFillsProps): React.JSX.Element {
  const [filter, setFilter] = useState<FillFilter>('all');
  const [pageSize, setPageSize] = useState<number>(10);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    if (filter === 'all') return trades;
    const want = filter === 'buys' ? 'BUY' : 'SELL';
    return trades.filter((t) => t.side === want);
  }, [trades, filter]);

  const buys = useMemo(() => trades.filter((t) => t.side === 'BUY').length, [trades]);
  const sells = trades.length - buys;

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const clampedPage = Math.min(page, pageCount);
  const start = (clampedPage - 1) * pageSize;
  const visible = filtered.slice(start, start + pageSize);

  return (
    <section
      aria-labelledby="bt-trades-h"
      className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
    >
      <h2 id="bt-trades-h" className="text-sm font-semibold text-fg">
        Fills ({trades.length})
      </h2>
      {trades.length === 0 ? (
        <p className="text-sm text-muted-fg">No fills.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1" role="group" aria-label="Filter fills by side">
              {(
                [
                  ['all', `All (${trades.length})`],
                  ['buys', `Buys (${buys})`],
                  ['sells', `Sells (${sells})`],
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
                  data-testid={`bt-fills-filter-${key}`}
                >
                  {label}
                </Button>
              ))}
            </div>
            <label className="flex items-center gap-1.5 text-xs text-muted-fg">
              Rows per page
              <Select
                variant="sm"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                data-testid="bt-fills-page-size"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </label>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums" data-testid="backtest-fills-table">
              <thead className="text-left text-xs text-muted-fg">
                <tr>
                  <th className="py-1 pr-3">Time</th>
                  <th className="py-1 pr-3">Symbol</th>
                  <th className="py-1 pr-3">Side</th>
                  <th className="py-1 pr-3">Reason</th>
                  <th className="py-1 pr-3">Price</th>
                  <th className="py-1 pr-3">Qty</th>
                  <th className="py-1 pr-3">Fee</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((t, i) => (
                  <tr key={`${t.tsMs}-${start + i}`} className="border-t border-border">
                    <td className="py-1 pr-3">{formatInstant(t.tsMs, timeZone)}</td>
                    <td className="py-1 pr-3">{t.symbol}</td>
                    <td className={`py-1 pr-3 ${t.side === 'BUY' ? 'text-up' : 'text-down'}`}>
                      {t.side}
                    </td>
                    <td className="py-1 pr-3">{t.reason}</td>
                    <td className="py-1 pr-3 font-mono">{formatPrice(t.price)}</td>
                    <td className="py-1 pr-3 font-mono">{formatAmount(t.qty)}</td>
                    <td className="py-1 pr-3 font-mono">{formatMoneyAmount(t.feeQuote)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted-fg" data-testid="bt-fills-range">
              {filtered.length === 0
                ? 'No fills match this filter'
                : `Showing ${start + 1}–${Math.min(start + pageSize, filtered.length)} of ${filtered.length}`}
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={clampedPage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                data-testid="bt-fills-prev"
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
                data-testid="bt-fills-next"
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
