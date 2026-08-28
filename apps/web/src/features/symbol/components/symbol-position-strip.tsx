// The operator's own stake in the open symbol: held position, resting-order
// count, and unrealised P/L. Sits under the market 24h strip in the workspace
// header so the answer to "what is MY money doing on this coin" is on the
// header, not one tab away. Display-only (apps/web is barred from decimal.js);
// P/L comes from the shared `unrealisedPnlOf` so it matches the dashboard.

import { AlertTriangle } from 'lucide-react';

import { isHeldPosition, unrealisedPnlOf } from '@/features/profile/lib/unrealised-pnl';
import { deriveQuote } from '@/shared/lib/symbol-quote';
import { formatAmount, formatPrice } from '@/shared/lib/format';
import { PnlValue } from '@/shared/components/pnl-value';

import type { SymbolStateResponse } from '@app/contracts';

// Stable id so the quantity can name the refusal through `aria-describedby`; one strip renders per symbol page, so a single constant cannot collide.
const REFUSAL_ID = 'symbol-position-refusal';

function Cell({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-fg">{label}</span>
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
  // The worker refused to seed a position from this cost basis. The row it refused is still the one rendered above, so without this the strip reports a holding the strategy does not have — and prices it.
  // `?? null` rather than a bare read: the field is defaulted at the contract boundary, but a body that never went through it (an optimistic write, a fixture) leaves it undefined, and `undefined !== null` would render the warning over every healthy position.
  const refusal = state.positionSeedRefusal ?? null;
  // Names the refusal rather than merely sitting above it: a screen reader announcing the figure alone gets the same sentence a sighted reader now sees corrected. Spread onto BOTH branches, because "Flat with a standing refusal" is not a contradiction — the paths that orphan the condition leave the state body empty while the operator's cost basis is still on file, and that is the reading most in need of the explanation.
  const describedBy = refusal !== null ? { 'aria-describedby': REFUSAL_ID } : {};

  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border border-border bg-bg-elevated px-4 py-3"
      data-testid="symbol-position-strip"
    >
      <Cell label="Position">
        {held && pos ? (
          <span data-testid="symbol-position" {...describedBy}>
            {formatAmount(pos.quantity)} @ {formatPrice(pos.avgEntryPrice)}
          </span>
        ) : (
          <span className="text-muted-fg" data-testid="symbol-position" {...describedBy}>
            Flat
          </span>
        )}
        {refusal !== null ? (
          // Words, not only a glyph. A warning triangle beside a quantity reads as "something is odd about this number"; what the operator has to learn is that the bot holds nothing here, and that the figure is a note they left themselves.
          <span
            id={REFUSAL_ID}
            data-testid="symbol-position-refusal"
            className="mt-0.5 flex items-center gap-1 font-sans text-xs font-normal text-warning"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            Not held — nothing sellable backs this cost basis.
          </span>
        ) : null}
      </Cell>
      <Cell label="Open orders">
        <span data-testid="symbol-open-orders">{state.openOrders.length}</span>
      </Cell>
      <Cell label="Unrealised P/L">
        {/* A refused seed has no P/L to show. The arithmetic still produces one — entry price and quantity are both on the row — and that number is the whole problem: it is a gain or loss on a position that will never be sold, sitting in the same place as every real one. `refusal === null` is the ordinary case, where this reads exactly as it did before. */}
        <PnlValue
          value={pnl == null || refusal !== null ? null : String(pnl)}
          {...(held && refusal === null ? { unit: quote } : {})}
          className="text-sm"
        />
      </Cell>
    </div>
  );
}
