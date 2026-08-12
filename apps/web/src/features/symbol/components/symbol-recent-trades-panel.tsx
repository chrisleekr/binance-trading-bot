// Symbol recent-trades panel — the Binance-style tape of recent public
// trades for the pair.
//
// Self-contained widget: owns its `/symbols/{sym}/trades` query and polls so
// the tape stays live without the route threading it. Each row is coloured by
// taker side — `isBuyerMaker` true means a sell-side taker hit a resting bid
// (red); false means a buy taker lifted an ask (green).
//
// Display-only — apps/web is barred from decimal.js; these values never feed
// an order, so a Number round-trip for formatting is safe.

import { useQuery } from '@tanstack/react-query';

import { fetchSymbolRecentTrades, symbolRecentTradesQueryKey } from '@/features/symbol/api/symbol';
import { TableSkeleton } from '@/shared/components/page-skeleton';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatAmount, formatPrice } from '@/shared/lib/format';
import { formatClock } from '@/shared/lib/format-time';

import type { RecentTrade } from '@app/contracts';

/** Trades stream fast; a 10s poll keeps the tape live without hammering Binance. */
const TRADES_REFETCH_MS = 10_000;

function TradeRow({
  trade,
  timeZone,
}: {
  readonly trade: RecentTrade;
  readonly timeZone: string;
}): React.JSX.Element {
  // `isBuyerMaker` true → a sell-side taker hit the bid → red; false → a buy
  // taker lifted the ask → green.
  const sideColor = trade.isBuyerMaker ? 'text-danger' : 'text-success';
  return (
    <li
      className="grid grid-cols-3 gap-2 px-3 py-1 text-xs tabular-nums"
      data-testid={`trade-row-${trade.id}`}
    >
      <span className={`font-mono ${sideColor}`}>
        {trade.isBuyerMaker ? '▼' : '▲'} {formatPrice(trade.price)}
      </span>
      <span className="text-right font-mono">{formatAmount(trade.qty)}</span>
      <span className="text-right font-mono text-muted-fg">
        {formatClock(trade.time, timeZone)}
      </span>
    </li>
  );
}

/**
 * Recent-trades panel for the symbol-detail screen. Self-contained: owns its
 * query and poll. Binance's `/api/v3/trades` returns oldest-first, so the list
 * is reversed to show the newest fill at the top. Loading / empty / error
 * degrade to a thin notice.
 */
export function SymbolRecentTradesPanel({
  profileId,
  symbol,
}: {
  readonly profileId: string;
  readonly symbol: string;
}): React.JSX.Element {
  const timeZone = useTimezone();
  const trades = useQuery({
    queryKey: symbolRecentTradesQueryKey(profileId, symbol),
    queryFn: () => fetchSymbolRecentTrades(profileId, symbol),
    refetchInterval: TRADES_REFETCH_MS,
    staleTime: TRADES_REFETCH_MS,
  });

  return (
    <section className="flex h-full flex-col space-y-2" data-testid="symbol-recent-trades-panel">
      <h2 className="text-sm font-semibold">Recent trades</h2>
      {trades.isSuccess && trades.data.length > 0 ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {/* Fills the card: this panel shares a stretch-aligned grid row with
              the taller order book, so the list grows to that height and
              scrolls within it instead of leaving the card half-empty. */}
          <div className="grid grid-cols-3 gap-2 px-3 text-xs tracking-wide text-muted-fg">
            <span>Price</span>
            <span className="text-right">Amount</span>
            <span className="text-right">Time</span>
          </div>
          {/* Mobile (single-column stack) has no taller sibling to fill, so a
              tighter cap keeps the tape from dominating the scroll; the wide
              cap only applies at xl where the order book sets the row height. */}
          <ul className="max-h-72 min-h-0 flex-1 divide-y divide-border overflow-y-auto rounded-md border xl:max-h-[34rem]">
            {[...trades.data].reverse().map((trade) => (
              <TradeRow key={trade.id} trade={trade} timeZone={timeZone} />
            ))}
          </ul>
        </div>
      ) : trades.isLoading ? (
        // Matches the loaded tape's `max-h-72` cap on the mobile stack.
        <TableSkeleton rows={7} />
      ) : (
        <p className="text-sm text-muted-fg">
          {trades.isError ? 'Recent trades unavailable.' : 'No recent trades.'}
        </p>
      )}
    </section>
  );
}
