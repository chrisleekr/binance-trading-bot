// Unrealised P/L on an open position: (mark - cost) * held quantity.
//
// Computed in the display layer because the inputs straddle Redis (live
// price) and Postgres (cost, quantity) and no server package on the
// dashboard read path may import decimal.js. `Number` math is display-only
// and safe here — apps/web is barred from decimal.js and none of these
// values feed an order. The `toFinite` parse and the held-position predicate
// live in `@app/contracts` so this display layer and the Postgres projection
// (`profile-aggregate`) share one definition instead of hand-synced copies.

import { isHeldPosition as isHeldPositionOf, toFinite } from '@app/contracts';

// Re-exported so the existing `@/features/profile/lib/unrealised-pnl` import
// sites (the "awaiting live price" branch) keep working off one definition.
export { toFinite };

/**
 * The decimal-string inputs an unrealised-P/L calculation needs. A structural
 * type so the helper serves both `ProfileDashboardSymbol` (the profile page)
 * and `DashboardPositionInput` (the home-screen rollup).
 */
interface UnrealisedInputs {
  readonly avgEntryPrice: string | null;
  readonly currentPrice: string | null;
  readonly quantity: string | null;
}

/**
 * True when the symbol is actually holding a position. Object-shaped adapter
 * over the shared `@app/contracts` predicate so the coin-grid badge, the
 * Positions counter, and the projection rollup decide "position" with one
 * definition and cannot drift apart.
 */
export function isHeldPosition(symbol: UnrealisedInputs): boolean {
  return isHeldPositionOf(symbol.avgEntryPrice, symbol.quantity);
}

/**
 * Unrealised P/L for one position, or `null` when it is flat (no last-buy
 * price / quantity) or has no usable live price yet. Rounded to 8dp so a
 * float-multiplication artifact never leaks into the readout.
 */
export function unrealisedPnlOf(symbol: UnrealisedInputs): number | null {
  const avgEntryPrice = toFinite(symbol.avgEntryPrice);
  const currentPrice = toFinite(symbol.currentPrice);
  const quantity = toFinite(symbol.quantity);
  // A zero or negative held quantity is not a position. Treating it as one
  // would render a contrived P/L of 0 on a flat ledger row, and would also
  // disagree with the cross-profile rollup (`profile-aggregate.rollupFor`),
  // which counts positions on the same `quantity > 0` predicate.
  if (avgEntryPrice == null || currentPrice == null || quantity == null || quantity <= 0)
    return null;
  const pnl = (currentPrice - avgEntryPrice) * quantity;
  return Number.isFinite(pnl) ? Number(pnl.toFixed(8)) : null;
}
