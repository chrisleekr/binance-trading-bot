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
 * The one extra field that separates "there is a quantity on this row" from "the strategy manages this position". Optional and structurally typed so a caller holding a row that predates the field, or a fixture that omits it, still type-checks and reads as unrefused.
 */
interface SeedRefusalInput {
  readonly positionSeedRefusal?:
    { readonly code: string; readonly since: string } | null | undefined;
}

/**
 * True when the strategy actually manages this position: held, AND the worker did not refuse to seed it from this cost basis.
 *
 * {@link isHeldPosition} answers from the cost-basis row alone, and a refusal is precisely the statement that that row is not backed by anything sellable — so every surface that prices a holding, counts one, or sorts by one needs this predicate rather than that one. It exists as a shared function for the same reason `isHeldPosition` does: the badge, the positions list, the ticker rollup and the sort comparator each decided it separately once, and a row can only be held on one screen and flat on the next if they are allowed to.
 *
 * @param symbol - A row carrying the cost-basis fields and, where the payload has it, the seed refusal.
 * @returns True when the row is a position the strategy is actually running.
 */
export function isManagedPosition(symbol: UnrealisedInputs & SeedRefusalInput): boolean {
  return (symbol.positionSeedRefusal ?? null) === null && isHeldPosition(symbol);
}

/**
 * Unrealised P/L for a position the strategy manages, or `null` when it refused the seed.
 *
 * The arithmetic still produces a number for a refused row — entry price and quantity are both right there — and that number is the whole problem: it is a gain or loss on a position that will never be sold, and summed into a rollup it moves a total the operator reads as money.
 *
 * @param symbol - A row carrying the cost-basis and live-price fields and, where the payload has it, the seed refusal.
 * @returns The P/L, or null when the position is refused, flat, or has no usable live price yet.
 */
export function managedUnrealisedPnlOf(symbol: UnrealisedInputs & SeedRefusalInput): number | null {
  return (symbol.positionSeedRefusal ?? null) === null ? unrealisedPnlOf(symbol) : null;
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
