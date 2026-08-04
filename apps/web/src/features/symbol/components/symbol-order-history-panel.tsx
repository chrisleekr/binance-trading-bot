// Symbol order-history panel — the operator's own past orders for the pair,
// Binance's "Order History" tab.
//
// Self-contained widget: owns its `/symbols/{sym}/orders` query and polls.
// Distinct from the live open-orders card (resting orders on
// `SymbolStateResponse`) and from the public market tape (`/trades`) — this
// is the persisted history of orders this bot placed, newest first: filled,
// cancelled, and still-open alike.
//
// Display-only — apps/web is barred from decimal.js; these values never feed
// an order, so a Number round-trip for formatting is safe.

import { useQuery } from '@tanstack/react-query';

import { fetchSymbolOrderHistory, symbolOrderHistoryQueryKey } from '@/features/symbol/api/symbol';
import { orderDisplayPrice, orderQty } from '@/features/symbol/lib/order-raw';
import { TableSkeleton } from '@/shared/components/page-skeleton';
import { Badge } from '@/shared/components/ui/badge';
import { formatAmount } from '@/shared/lib/format';
import { formatInstant } from '@/shared/lib/format-time';
import { useTimezone } from '@/shared/context/timezone-context';

import type { OrderIntent, OrderResponse } from '@app/contracts';

/** Orders close on fills/cancels, not every tick — a 15s poll keeps the list fresh enough. */
const ORDERS_REFETCH_MS = 15_000;

/** A terminal-but-unfilled status reads as muted; a live one stays default. */
function statusTone(status: string): string {
  const s = status.toUpperCase();
  if (s === 'FILLED') return 'text-success';
  if (s === 'CANCELED' || s === 'CANCELLED' || s === 'EXPIRED' || s === 'REJECTED')
    return 'text-muted-fg';
  return 'text-fg';
}

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'warning' | 'danger';

/**
 * Maps an OrderIntent to a Badge variant + display label. `intent` is an
 * open, strategy-owned string, so the known trailing-trade intents get bespoke
 * tints and any other strategy's intent (e.g. a momentum `entry`/`exit`) falls
 * back to its raw label with the default tint. Operator-driven `manual` reads
 * as a neutral outline; a Technicals force-sell is `warning` (reacting to a
 * signal); a stop-loss exit is `danger` (capital preservation, loudest visual).
 * `grid-stop-loss` is relabelled to plain `stop-loss` so the chip matches the
 * operator's vocabulary.
 */
function sourceChip(intent: OrderIntent): { label: string; variant: BadgeVariant } {
  switch (intent) {
    case 'manual':
      return { label: 'manual', variant: 'outline' };
    case 'technicals-force-sell':
      return { label: 'technicals-force-sell', variant: 'warning' };
    case 'grid-stop-loss':
      return { label: 'stop-loss', variant: 'danger' };
    case 'regime-exit':
      return { label: 'regime-exit', variant: 'danger' };
    default:
      return { label: intent, variant: 'default' };
  }
}

// All-caps reads fine only on the short 2–6 char status tokens the design spec
// sanctions (MANUAL, STOP-LOSS); longer intents (technicals-force-sell, or a
// future strategy's verbose intent) shout when caps-locked, so leave them as-is.
const SHORT_CHIP_MAX = 6;

function OrderRow({
  order,
  timeZone,
}: {
  readonly order: OrderResponse;
  readonly timeZone: string;
}): React.JSX.Element {
  const sideColor = order.side === 'BUY' ? 'text-success' : 'text-danger';
  const chip = sourceChip(order.intent);
  return (
    <li
      // 5 columns < sm so the Source folds into the Side cell as `BUY · grid-buy`;
      // 6 columns at sm+ promotes Source to its own column with a coloured chip.
      className="grid grid-cols-5 gap-2 px-3 py-1 text-sm tabular-nums sm:grid-cols-6"
      data-testid={`order-history-row-${order.id}`}
    >
      <span className="text-muted-fg font-mono">{formatInstant(order.createdAt, timeZone)}</span>
      <span className={`font-medium ${sideColor}`} data-testid={`order-history-side-${order.id}`}>
        {order.side}
        {/* Narrow-viewport fallback: keeps the original "BUY · grid-buy"
            single-line readout. The literal `·` text (not just CSS spacing)
            stops a screen reader from concatenating to `BUYgrid-buy`. */}
        <span className="text-muted-fg font-normal sm:hidden"> · {chip.label}</span>
      </span>
      <Badge
        variant={chip.variant}
        // `hidden sm:inline-flex` — promoted-column chip only renders at sm+.
        // `justify-self-start` keeps the chip from stretching across the
        // grid cell when the column is wider than the badge content.
        // `uppercase` only on short tokens (see SHORT_CHIP_MAX).
        className={`hidden justify-self-start sm:inline-flex ${chip.label.length <= SHORT_CHIP_MAX ? 'uppercase' : ''}`}
        data-testid={`order-history-source-${order.id}`}
      >
        {chip.label}
      </Badge>
      <span className="text-right font-mono" data-testid={`order-history-price-${order.id}`}>
        {orderDisplayPrice(order)}
      </span>
      <span className="text-right font-mono">{formatAmount(orderQty(order))}</span>
      <span
        className={`text-right ${statusTone(order.status)}`}
        data-testid={`order-history-status-${order.id}`}
      >
        {order.status}
      </span>
    </li>
  );
}

/**
 * Order-history panel for the symbol-detail screen. Self-contained: owns its
 * query and poll. The projection returns rows newest-first. Loading / empty /
 * error degrade to a thin notice.
 */
export function SymbolOrderHistoryPanel({
  profileId,
  symbol,
}: {
  readonly profileId: string;
  readonly symbol: string;
}): React.JSX.Element {
  const timeZone = useTimezone();
  const orders = useQuery({
    queryKey: symbolOrderHistoryQueryKey(profileId, symbol),
    queryFn: () => fetchSymbolOrderHistory(profileId, symbol),
    refetchInterval: ORDERS_REFETCH_MS,
    staleTime: ORDERS_REFETCH_MS,
  });

  return (
    <section className="space-y-2" data-testid="symbol-order-history-panel">
      <h2 className="text-sm font-semibold">Order history</h2>
      {orders.isSuccess && orders.data.items.length > 0 ? (
        // Below sm the table reflows to fit the 375px viewport (invariant #3);
        // from sm up it keeps a comfortable min width and scrolls horizontally
        // within the card so the columns stay legible.
        <div className="border-border overflow-x-auto rounded-md border">
          <div className="sm:min-w-[30rem] md:min-w-[36rem]">
            <div className="text-muted-fg grid grid-cols-5 gap-2 px-3 py-1 text-xs tracking-wide sm:grid-cols-6">
              <span>Time</span>
              <span>Side</span>
              <span className="hidden sm:inline">Source</span>
              <span className="text-right">Price</span>
              <span className="text-right">Amount</span>
              <span className="text-right">Status</span>
            </div>
            <ul className="divide-border max-h-80 divide-y overflow-y-auto border-t">
              {orders.data.items.map((order) => (
                <OrderRow key={order.id} order={order} timeZone={timeZone} />
              ))}
            </ul>
          </div>
        </div>
      ) : orders.isLoading ? (
        // Matches the loaded list's `max-h-80` cap, so the box does not resize
        // under the operator's thumb when the rows arrive.
        <TableSkeleton rows={7} />
      ) : (
        <p className="text-muted-fg text-sm">
          {orders.isError
            ? 'Order history unavailable.'
            : 'No orders yet for this symbol. If you expected some, check whether trading is paused (banner above) or the strategy is still waiting for entry conditions.'}
        </p>
      )}
    </section>
  );
}
