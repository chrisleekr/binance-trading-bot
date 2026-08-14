// ORDERS tab of the symbol workspace: the strategy's grid ladder and flat-state
// projection, the live open-orders list (with the cancel affordance), and the
// closed-order history.

import { SymbolOrderHistoryPanel } from '@/features/symbol/components/symbol-order-history-panel';
import { orderDisplayPrice, orderQty } from '@/features/symbol/lib/order-raw';
import { Badge } from '@/shared/components/ui/badge';
import { FormActions } from '@/shared/components/form-actions';
import { Button } from '@/shared/components/ui/button';
import { Card } from '@/shared/components/ui/card';
import { formatAmount } from '@/shared/lib/format';
import { type StrategyView } from '@/features/symbol/strategies/types';

import type { OrderResponse, SymbolStateResponse } from '@app/contracts';

export function WorkspaceOrdersTab({
  profileId,
  symbol,
  state,
  currentPrice,
  view,
  onCancel,
}: {
  profileId: string;
  symbol: string;
  state: SymbolStateResponse | undefined;
  currentPrice: string | null;
  view: StrategyView;
  onCancel: (order: OrderResponse) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        {state && view.SidePanel ? (
          <Card>
            <view.SidePanel
              profileId={profileId}
              symbol={symbol}
              state={state}
              currentPrice={currentPrice}
            />
          </Card>
        ) : null}
        {state ? (
          <Card>
            <OpenOrdersPanel orders={state.openOrders} onCancel={onCancel} />
          </Card>
        ) : null}
      </div>

      <Card>
        <SymbolOrderHistoryPanel profileId={profileId} symbol={symbol} />
      </Card>
    </div>
  );
}

function OpenOrdersPanel({
  orders,
  onCancel,
}: {
  readonly orders: readonly OrderResponse[];
  readonly onCancel: (order: OrderResponse) => void;
}): React.JSX.Element {
  if (orders.length === 0) {
    return (
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-fg">Open orders</h2>
        <p className="text-sm text-muted-fg">No open orders.</p>
      </section>
    );
  }
  return (
    <section className="space-y-2" data-testid="open-orders-panel">
      <h2 className="text-sm font-semibold text-fg">Open orders</h2>
      <ul className="divide-y divide-border rounded-md border">
        {orders.map((order) => (
          <li
            key={order.id}
            className="space-y-1 px-3 py-2 text-xs"
            data-testid={`order-row-${order.id}`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span
                className={order.side === 'BUY' ? 'font-medium text-up' : 'font-medium text-down'}
              >
                {order.side}
              </span>
              <Badge variant={order.status === 'PARTIALLY_FILLED' ? 'warning' : 'outline'}>
                {order.status}
              </Badge>
            </div>
            <div className="flex justify-between text-muted-fg">
              <span>qty {formatAmount(orderQty(order))}</span>
              <span>@ {orderDisplayPrice(order)}</span>
            </div>
            <FormActions>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onCancel(order)}
                data-testid={`order-cancel-${order.id}`}
              >
                Cancel
              </Button>
            </FormActions>
          </li>
        ))}
      </ul>
    </section>
  );
}
