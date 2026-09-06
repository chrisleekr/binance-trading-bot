// Shared order-sizing money-boundary primitives. Every strategy's sizing
// functions parse the same per-symbol lot-size filters and end with the same
// min-qty -> min-notional -> step-format epilogue. Hoisted here, Decimal-typed
// and side-effect-free (inside the strategy purity boundary), so a sizing
// change (e.g. a min-notional rounding tweak) lands in one place, not once per
// strategy per order-kind.

import {
  Decimal,
  ceilToStep,
  meetsMinNotional,
  roundToStep,
  roundToTick,
  toFixedStep,
} from '@app/money';
import type { SymbolFilters } from './contract.js';

/** Parsed, validated per-symbol exchange filters for order sizing. */
export interface SizeFilters {
  readonly step: Decimal;
  readonly minQty: Decimal;
  readonly minNotional: Decimal;
  /**
   * The symbol's price grid, carried alongside the quantity filters so a caller that must price an order before sizing it reads ONE parse of the symbol rather than deriving a second. Optional because it is not a lot-size filter: a caller that only converts a budget into a quantity never needs it, and a symbol whose `tickSize` does not parse must still size such an order. The one consumer that does need a grid refuses rather than proceeds when it is absent.
   */
  readonly tick?: Decimal | undefined;
}

/** Stop inputs needed to prevent an entry from creating a position that cannot meet the stop's exchange minimum. */
export interface EntryStopFloor {
  /** Fraction of the entry price that the stop trigger sits below the entry price. For example, 0.1 places the trigger at 90% of entry; this is not the trailing-trade strategy config's ratio style, where stopLossPercentage: '0.9' means sell at 90% of the reference price. */
  readonly distanceFraction: Decimal;
  /** Multiplier applied to the trigger price to derive the limit sell price. A value of 1 means an in-process MARKET-style stop with no separate exchange limit leg because the limit price equals the trigger price. */
  readonly limitOffset: Decimal;
}

/** Typed skip reason for an entry whose budget cannot fund a sellable stop quantity. */
const ENTRY_BELOW_STOP_NOTIONAL = 'entry-below-stop-notional' as const;

/** Binance VIP0 spot taker fee assumed when BNB does not pay the fee and the fill deducts base asset. */
const ENTRY_FEE_MARGIN: Decimal = new Decimal('0.001');

const ONE = new Decimal(1);

// Parsed apart from the quantity filters, and never fatal, because the two answer different questions: a non-positive or malformed `tickSize` leaves a symbol unpriceable but still sizeable, and turning it into an `invalid-filters` skip would refuse every order on a symbol whose caller prices nothing.
const parseTick = (tickSize: string): Decimal | undefined => {
  try {
    const tick = new Decimal(tickSize);
    return tick.gt(0) ? tick : undefined;
  } catch {
    return undefined;
  }
};

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
    return { step, minQty, minNotional, tick: parseTick(filters.tickSize) };
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

/** Find the smallest pre-fee ENTRY quantity whose fee-reduced, step-rounded SELL meets the exchange minimum at the stop. The entry-side margin takes the larger of the minimum-quantity and minimum-notional arms, adds one possible exit step, then divides by the surviving base fraction because the buy fee reduces held base and the exit rounds it down; the held-side floor below omits both because a held position is already post-fee.
 * @param filters - The validated symbol quantity and notional filters.
 * @param stopPrice - The protective-stop limit price used for the eventual sell.
 * @returns The step-aligned minimum sellable quantity, or null when the stop price cannot produce a positive notional.
 */
export const minSellableQuantityAtStop = (
  filters: SizeFilters,
  stopPrice: Decimal,
): Decimal | null => {
  if (stopPrice.lte(0)) return null;
  return ceilToStep(
    Decimal.max(filters.minQty, filters.minNotional.div(stopPrice))
      .plus(filters.step)
      .div(ONE.minus(ENTRY_FEE_MARGIN)),
    filters.step,
  );
};

/** Find the smallest already-held quantity whose step-rounded SELL meets the exchange minimum at the stop. It models the held side, so no entry fee margin is needed: the tracked position is already post-fee, unlike the pre-fee entry quantity handled by minSellableQuantityAtStop.
 * @param filters - The validated symbol quantity and notional filters.
 * @param stopPrice - The protective-stop limit price used for the eventual sell.
 * @returns The step-aligned minimum sellable held quantity, or null when the stop price cannot produce a positive notional.
 */
export const minSellableHeldQuantity = (
  filters: SizeFilters,
  stopPrice: Decimal,
): Decimal | null => {
  if (stopPrice.lte(0)) return null;
  return Decimal.max(filters.minQty, ceilToStep(filters.minNotional.div(stopPrice), filters.step));
};

/** Check whether a bought quantity remains sellable after the assumed base-asset fee and exchange step round-down at the stop.
 * @param quantity - The bought base quantity before fees.
 * @param stopPrice - The protective-stop limit price used for the sell.
 * @param filters - The validated symbol quantity and notional filters.
 * @returns True when the step-rounded remaining quantity passes the exchange minimums.
 */
export const sellableAtStop = (
  quantity: Decimal,
  stopPrice: Decimal,
  filters: SizeFilters,
): boolean => !('skip' in finalise(roundToStep(quantity, filters.step), stopPrice, filters));

/** Gate an entry on the quantity needed for a sellable protective stop. The naive quantity is the largest step-aligned value no greater than the configured budget divided by entry price, so falling below the stop floor proves that the floor would exceed that budget; a non-positive derived stop cannot prove any quantity sellable, so it fails closed. There is deliberately no raise path because it would spend beyond the operator's configured or risk-based size.
 *
 * The stop price is quantised onto the symbol's price grid twice, trigger then limit, because that is what the arm will send and Binance judges the minimum on the bytes it receives, not on the exact product. Both quantisations FLOOR, so an unquantised product overstates the sell price by up to two ticks, and the `+ step` and 0.1% fee margins are quantity-scale where a tick is price-scale: on a coarse-tick pair they cover none of the gap. Skipping the quantisation is what admits an entry the arm then declines to guard.
 * @param quantity - The entry quantity already derived from the budget and entry-price filters.
 * @param price - The entry price used to derive the protective-stop limit price.
 * @param filters - The validated symbol quantity and notional filters, including the price grid the stop will be quantised onto.
 * @param stop - The configured stop distance and limit offset, or null when no stop is active.
 * @returns The original quantity, or a typed skip when it is below the stop-safe floor.
 */
export const applyEntryStopFloor = (
  quantity: Decimal,
  price: Decimal,
  filters: SizeFilters,
  stop: EntryStopFloor | null,
): { quantity: Decimal } | { skip: typeof ENTRY_BELOW_STOP_NOTIONAL } => {
  if (stop === null) return { quantity };
  const tick = filters.tick;
  // Without the grid there is no way to ask the arm's question, and the arm itself rests nothing on a symbol whose tick does not parse. Admitting the entry anyway would create exactly the unguardable position this gate exists to prevent.
  if (tick === undefined || tick.lte(0)) return { skip: ENTRY_BELOW_STOP_NOTIONAL };
  const trigger = roundToTick(price.mul(ONE.minus(stop.distanceFraction)), tick);
  const stopPrice = roundToTick(trigger.mul(stop.limitOffset), tick);
  const floor = minSellableQuantityAtStop(filters, stopPrice);
  if (floor === null) return { skip: ENTRY_BELOW_STOP_NOTIONAL };
  if (quantity.gte(floor)) return { quantity };
  return { skip: ENTRY_BELOW_STOP_NOTIONAL };
};
