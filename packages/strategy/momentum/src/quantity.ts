import { Decimal, roundToStep } from '@app/money';
import { finalise, parseFilters, type SymbolFilters } from '@app/strategy-core';

/**
 * Skip-reason tag a sizing rejection carries so the no-silent-failure
 * invariant holds for cases that look like a hung strategy from outside;
 * downstream metrics key on each tag.
 */
export type SizeSkipReason = 'min-qty' | 'min-notional' | 'invalid-filters';

type SizeResult = { readonly quantity: string } | { readonly skip: SizeSkipReason };

/**
 * Entry quantity for the configured quote-asset budget under Binance's
 * per-symbol filters. Returns a typed skip rather than throwing so the tick
 * handler emits the matching metric. `new Decimal()` throws on malformed
 * input, treated as `invalid-filters`.
 */
export const computeEntryQuantity = (
  quoteAmount: string,
  currentPrice: string,
  filters: SymbolFilters,
): SizeResult => {
  const parsed = parseFilters(filters);
  if (parsed === null) return { skip: 'invalid-filters' };
  let price: Decimal;
  let budget: Decimal;
  try {
    price = new Decimal(currentPrice);
    budget = new Decimal(quoteAmount);
  } catch {
    return { skip: 'invalid-filters' };
  }
  if (price.lte(0)) return { skip: 'invalid-filters' };
  const quantity = roundToStep(budget.div(price), parsed.step);
  return finalise(quantity, price, parsed);
};

/**
 * Exit quantity from the held base-asset balance, rounded down to the symbol's
 * stepSize so the order satisfies Binance's lot-size filter. Same typed-skip
 * contract as {@link computeEntryQuantity}.
 */
export const computeExitQuantity = (
  heldQuantity: string,
  currentPrice: string,
  filters: SymbolFilters,
): SizeResult => {
  const parsed = parseFilters(filters);
  if (parsed === null) return { skip: 'invalid-filters' };
  let price: Decimal;
  let held: Decimal;
  try {
    price = new Decimal(currentPrice);
    held = new Decimal(heldQuantity);
  } catch {
    return { skip: 'invalid-filters' };
  }
  if (price.lte(0)) return { skip: 'invalid-filters' };
  const quantity = roundToStep(held, parsed.step);
  return finalise(quantity, price, parsed);
};
