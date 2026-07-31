// "Your money now": the operator's live open positions and resting open orders
// across every visible profile, in one block above the symbol table. Positions
// are also in the table, but the actual orders (side / price / qty) were only a
// count before this — so an operator had to drill into a symbol to see what is
// resting. Reuses the same `useSymbolRows` fan-out the table uses (React Query
// dedupes the per-profile queries), so this adds no extra fetch.

import { Link } from '@tanstack/react-router';

import { useSymbolRows } from '@/features/dashboard/lib/use-symbol-rows';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { isHeldPosition, unrealisedPnlOf } from '@/features/profile/lib/unrealised-pnl';
import { orderDisplayPrice, orderQty } from '@/features/symbol/lib/order-raw';
import { deriveQuote } from '@/shared/lib/symbol-quote';
import { formatAmount, formatPrice } from '@/shared/lib/format';
import { PnlValue } from '@/shared/components/pnl-value';

import type { DashboardAggregateRow } from '@app/contracts';

export function PositionsOrdersPanel({
  rows,
}: {
  rows: readonly DashboardAggregateRow[];
}): React.JSX.Element | null {
  const accountId = useActiveAccountId() ?? '';
  const merged = useSymbolRows(rows);
  const positions = merged.items.filter((r) => isHeldPosition(r.sym));
  const orders = merged.items.flatMap((r) =>
    r.sym.openOrders.map((order) => ({ profileId: r.profileId, symbol: r.sym.symbol, order })),
  );

  // Nothing in play → don't show an empty "your money" block.
  if (positions.length === 0 && orders.length === 0) return null;

  return (
    <section
      aria-labelledby="money-now-heading"
      className="space-y-2"
      data-testid="positions-orders-panel"
    >
      <h2
        id="money-now-heading"
        className="text-muted-fg text-[11px] font-semibold uppercase tracking-wider"
      >
        Your money now
      </h2>
      {/* 1px-gap grid so the border shows through as hairline dividers (the v2
          band treatment), one column on a phone, two on sm+. */}
      <div className="border-border bg-border grid gap-px border sm:grid-cols-2">
        <div className="bg-bg-elevated space-y-1.5 p-3" data-testid="money-positions">
          <p className="text-muted-fg text-xs">Open positions ({positions.length})</p>
          {positions.length === 0 ? (
            <p className="text-muted-fg text-xs">None.</p>
          ) : (
            <ul className="space-y-1">
              {positions.map((r) => {
                const pnl = unrealisedPnlOf(r.sym);
                return (
                  <li
                    key={`${r.profileId}:${r.sym.symbol}`}
                    className="flex items-baseline gap-2 text-xs"
                    data-testid={`money-position-${r.sym.symbol}`}
                  >
                    <Link
                      to="/accounts/$accountId/profiles/$profileId/symbols/$symbol"
                      params={{ accountId, profileId: r.profileId, symbol: r.sym.symbol }}
                      className="text-fg hover:text-accent shrink-0 font-mono font-medium"
                    >
                      {r.sym.symbol}
                    </Link>
                    <span className="text-muted-fg flex-1 truncate font-mono tabular-nums">
                      {formatAmount(r.sym.quantity ?? '0')} @{' '}
                      {formatPrice(r.sym.avgEntryPrice ?? '0')}
                    </span>
                    <PnlValue
                      value={pnl == null ? null : String(pnl)}
                      unit={deriveQuote(r.sym.symbol) ?? r.sym.symbol}
                      className="shrink-0 text-right"
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="bg-bg-elevated space-y-1.5 p-3" data-testid="money-orders">
          <p className="text-muted-fg text-xs">Open orders ({orders.length})</p>
          {orders.length === 0 ? (
            <p className="text-muted-fg text-xs">None.</p>
          ) : (
            <ul className="space-y-1">
              {orders.map(({ profileId, symbol, order }) => (
                <li
                  key={order.id}
                  className="flex items-baseline gap-2 text-xs"
                  data-testid={`money-order-${order.id}`}
                >
                  <Link
                    to="/accounts/$accountId/profiles/$profileId/symbols/$symbol"
                    params={{ accountId, profileId, symbol }}
                    search={{ tab: 'orders' }}
                    className="text-fg hover:text-accent shrink-0 font-mono font-medium"
                  >
                    {symbol}
                  </Link>
                  <span
                    className={`shrink-0 font-semibold ${order.side === 'BUY' ? 'text-up' : 'text-down'}`}
                  >
                    {order.side}
                  </span>
                  {/* One coin can legitimately rest several orders at once — at
                      most one per intent, so a take-profit sell and a protective
                      stop coexist. Without the intent both render as a bare
                      "SELL" and read as a duplicate bug. */}
                  <span className="text-muted-fg shrink-0 font-mono">{order.intent}</span>
                  <span className="text-muted-fg flex-1 truncate text-right font-mono tabular-nums">
                    {formatAmount(orderQty(order))} @ {orderDisplayPrice(order)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
