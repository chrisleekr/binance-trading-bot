// Shared order-sizing money-boundary primitives. Every strategy's sizing
// functions parse the same per-symbol lot-size filters and end with the same
// min-qty -> min-notional -> step-format epilogue. Hoisted here, Decimal-typed
// and side-effect-free (inside the strategy purity boundary), so a sizing
// change (e.g. a min-notional rounding tweak) lands in one place, not once per
// strategy per order-kind.

import { Decimal, meetsMinNotional, toFixedStep } from '@app/money';
import type { SymbolFilters } from './contract.js';

/** Parsed, validated lot-size filters for order sizing. */
export interface SizeFilters {
  readonly step: Decimal;
  readonly minQty: Decimal;
  readonly minNotional: Decimal;
}

/**
 * Parse a symbol's `stepSize` / `minQty` / `minNotional` into Decimals, or
 * `null` when a value is unparseable or `stepSize` is non-positive. Sizing
 * functions map the `null` to a typed `invalid-filters` skip rather than
 * throwing, so a bad snapshot value surfaces as a metric, not a crash.
 */
export const parseFilters = (filters: SymbolFilters): SizeFilters | null => {
  try {
    const step = new Decimal(filters.stepSize);
    const minQty = new Decimal(filters.minQty);
    const minNotional = new Decimal(filters.minNotional);
    if (step.lte(0)) return null;
    return { step, minQty, minNotional };
  } catch {
    return null;
  }
};

/**
 * The shared sizing epilogue: reject a sub-`minQty` or sub-`minNotional`
 * order with a typed skip, else return the quantity formatted to the symbol's
 * `stepSize`. `price` is the notional reference (market or operator-typed).
 */
export const finalise = (
  quantity: Decimal,
  price: Decimal,
  filters: SizeFilters,
): { quantity: string } | { skip: 'min-qty' | 'min-notional' } => {
  if (quantity.lte(0) || quantity.lt(filters.minQty)) return { skip: 'min-qty' };
  if (!meetsMinNotional(quantity, price, filters.minNotional)) return { skip: 'min-notional' };
  return { quantity: toFixedStep(quantity, filters.step) };
};
