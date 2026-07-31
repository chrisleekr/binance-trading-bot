import type { ManualOrderRequest } from '@app/contracts';
import { Decimal, roundToStep } from '@app/money';
import { finalise, parseFilters, type SymbolFilters } from '@app/strategy-core';

/**
 * Skip-reason tag every first-buy rejection carries so the
 * no-silent-failure invariant holds for cases that look like a hung
 * strategy from outside; downstream metrics key on each tag.
 */
export type FirstBuySkipReason = 'min-qty' | 'min-notional' | 'min-purchase' | 'invalid-filters';

/**
 * Decide the first-buy quantity for the configured max-purchase budget under
 * Binance's per-symbol filters. Returns a skip-reason rather than throwing so
 * the caller can emit the corresponding metric; downstream dashboards
 * distinguish filter rejections from a gate veto.
 */
export const computeFirstBuyQuantity = (
  maxPurchaseAmount: string,
  currentPrice: string,
  filters: SymbolFilters,
  // Per-grid min purchase amount: the floor on quote spent at this level.
  // Empty (default) applies no floor, so the single-buy call site and
  // existing grid configs are unchanged. When set, an order whose notional
  // (after stepSize rounding) falls below it skips with `min-purchase` rather
  // than placing a smaller order than the operator allowed.
  minPurchaseAmount = '',
): { quantity: string } | { skip: FirstBuySkipReason } => {
  // `new Decimal()` throws on malformed input (empty / `'abc'` / `undefined`),
  // which would break the documented "skip-not-throw" contract if a snapshot
  // arrived with a bad wire value. Treat any parse failure as invalid-filters.
  const parsed = parseFilters(filters);
  if (parsed === null) return { skip: 'invalid-filters' };
  let price: Decimal;
  let budget: Decimal;
  try {
    price = new Decimal(currentPrice);
    budget = new Decimal(maxPurchaseAmount);
  } catch {
    return { skip: 'invalid-filters' };
  }
  if (price.lte(0)) return { skip: 'invalid-filters' };
  const quantity = roundToStep(budget.div(price), parsed.step);
  const sized = finalise(quantity, price, parsed);
  if ('skip' in sized) return sized;
  if (minPurchaseAmount !== '') {
    let minSpend: Decimal;
    try {
      minSpend = new Decimal(minPurchaseAmount);
    } catch {
      return { skip: 'invalid-filters' };
    }
    // Decimal arithmetic (decimal.js is allowed past the money boundary; the
    // ban is on IEEE-754 `number`). A level budget that rounds below the
    // operator's floor is a deliberate skip, not a quiet under-spend. The check
    // reads the pre-format `quantity`, so running it after `finalise` is
    // behaviour-identical to the inline version.
    if (minSpend.gt(0) && quantity.mul(price).lt(minSpend)) return { skip: 'min-purchase' };
  }
  return sized;
};

/**
 * Skip-reason tag for the manual-order quantity computation. Extends
 * {@link FirstBuySkipReason} with three operator-input failure modes
 * that are specific to manual orders. First-buy gets its qty from
 * config + market state and cannot encounter these.
 */
export type ManualOrderSkipReason =
  | FirstBuySkipReason
  | 'missing-amount'
  | 'missing-price'
  | 'unsupported-type';

/**
 * Resolve the base-asset quantity for an operator-pushed manual order
 * under Binance per-symbol filters.
 *
 * Branches by `payload.type`:
 *   - `MARKET`: notional pre-check uses `marketPrice` (the latest
 *     mini-ticker) so a worker-side reject surfaces before Binance does.
 *     Either `payload.quantity` or `payload.quoteAmount` is accepted; the
 *     latter is divided by `marketPrice` to derive qty.
 *   - `LIMIT`: requires an explicit `payload.price`. quoteAmount is
 *     divided by the operator-typed price (not the market price); a
 *     deliberately-far-from-market LIMIT must size against the price the
 *     operator chose, not the current book.
 *   - `STOP_LOSS_LIMIT` / `TAKE_PROFIT_LIMIT`: rejected with
 *     `unsupported-type` because `ManualOrderRequest` doesn't carry the
 *     `stopPrice` Binance requires for these. Surfaces explicitly rather
 *     than guessing.
 *
 * Pure: skip-reasons mirror {@link computeFirstBuyQuantity} so the tick
 * handler emits a typed log and metric instead of throwing.
 */
export const computeManualOrderQuantity = (
  payload: ManualOrderRequest,
  marketPrice: string,
  filters: SymbolFilters,
): { quantity: string } | { skip: ManualOrderSkipReason } => {
  if (payload.type !== 'MARKET' && payload.type !== 'LIMIT') {
    return { skip: 'unsupported-type' };
  }
  let refPrice: Decimal;
  try {
    if (payload.type === 'LIMIT') {
      if (payload.price === undefined || payload.price.trim() === '') {
        return { skip: 'missing-price' };
      }
      refPrice = new Decimal(payload.price);
    } else {
      refPrice = new Decimal(marketPrice);
    }
  } catch {
    return { skip: 'invalid-filters' };
  }
  if (refPrice.lte(0)) return { skip: 'invalid-filters' };

  const parsed = parseFilters(filters);
  if (parsed === null) return { skip: 'invalid-filters' };

  let quantity: Decimal;
  if (payload.quantity !== undefined && payload.quantity.trim() !== '') {
    try {
      quantity = roundToStep(new Decimal(payload.quantity), parsed.step);
    } catch {
      return { skip: 'invalid-filters' };
    }
  } else if (payload.quoteAmount !== undefined && payload.quoteAmount.trim() !== '') {
    try {
      quantity = roundToStep(new Decimal(payload.quoteAmount).div(refPrice), parsed.step);
    } catch {
      return { skip: 'invalid-filters' };
    }
  } else {
    return { skip: 'missing-amount' };
  }

  return finalise(quantity, refPrice, parsed);
};

/** Skip reasons unique to the sell side of the strategy. */
export type SellSkipReason = 'no-balance' | 'min-qty' | 'min-notional' | 'invalid-filters';

/**
 * Resolve the SELL quantity from the operator's free balance in the
 * base asset (locked balance is excluded because it's tied up in an
 * existing order). Rounds down to the symbol's `stepSize` so the
 * order satisfies Binance's lot-size filter, then enforces minQty
 * and minNotional. Skips with `no-balance` when the operator holds
 * nothing (common after a prior sell or for a fresh profile).
 */
export const computeSellQuantity = (
  freeBase: string,
  currentPrice: string,
  filters: SymbolFilters,
): { quantity: string } | { skip: SellSkipReason } => {
  const parsed = parseFilters(filters);
  if (parsed === null) return { skip: 'invalid-filters' };
  let free: Decimal;
  let price: Decimal;
  try {
    free = new Decimal(freeBase);
    price = new Decimal(currentPrice);
  } catch {
    return { skip: 'invalid-filters' };
  }
  if (price.lte(0)) return { skip: 'invalid-filters' };
  if (free.lte(0)) return { skip: 'no-balance' };
  const quantity = roundToStep(free, parsed.step);
  return finalise(quantity, price, parsed);
};
