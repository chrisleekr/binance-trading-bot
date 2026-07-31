// The operator's own stake in the open symbol: held position, resting-order
// count, and unrealised P/L. Sits under the market 24h strip in the workspace
// header so the answer to "what is MY money doing on this coin" is on the
// header, not one tab away. Display-only (apps/web is barred from decimal.js);
// P/L comes from the shared `unrealisedPnlOf` so it matches the dashboard.

import { isHeldPosition, unrealisedPnlOf } from '@/features/profile/lib/unrealised-pnl';
import { deriveQuote } from '@/shared/lib/symbol-quote';
import { formatAmount, formatPrice } from '@/shared/lib/format';
import { PnlValue } from '@/shared/components/pnl-value';

import type { SymbolStateResponse } from '@app/contracts';

function Cell({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-fg text-xs">{label}</span>
      <span className="font-mono text-sm font-medium tabular-nums">{children}</span>
    </div>
  );
}

export function SymbolPositionStrip({
  state,
  currentPrice,
  symbol,
}: {
  readonly state: SymbolStateResponse;
  readonly currentPrice: string | null;
  readonly symbol: string;
}): React.JSX.Element {
  const pos = state.avgEntryPrice;
  const inputs = {
    avgEntryPrice: pos?.avgEntryPrice ?? null,
    currentPrice,
    quantity: pos?.quantity ?? null,
  };
  const held = isHeldPosition(inputs);
  const pnl = unrealisedPnlOf(inputs);
  const quote = deriveQuote(symbol) ?? symbol;

  return (
    <div
      className="border-border bg-bg-elevated flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border px-4 py-3"
      data-testid="symbol-position-strip"
    >
      <Cell label="Position">
        {held && pos ? (
          <span data-testid="symbol-position">
            {formatAmount(pos.quantity)} @ {formatPrice(pos.avgEntryPrice)}
          </span>
        ) : (
          <span className="text-muted-fg" data-testid="symbol-position">
            Flat
          </span>
        )}
      </Cell>
      <Cell label="Open orders">
        <span data-testid="symbol-open-orders">{state.openOrders.length}</span>
      </Cell>
      <Cell label="Unrealised P/L">
        <PnlValue
          value={pnl == null ? null : String(pnl)}
          {...(held ? { unit: quote } : {})}
          className="text-sm"
        />
      </Cell>
    </div>
  );
}
