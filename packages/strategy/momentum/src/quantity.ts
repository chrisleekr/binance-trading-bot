import { Decimal, roundToStep } from '@app/money';
import {
  applyEntryStopFloor,
  decOrNull,
  finalise,
  parseFilters,
  type EntryStopFloor,
  type SymbolFilters,
} from '@app/strategy-core';
import type { Candle } from '@app/strategy-core';

import { DEFAULT_LIMIT_OFFSET } from './protective-stop.js';
import { initialStopDistanceFraction, unitFraction } from './trailing-stop.js';
import type { MomentumConfig } from './schema.js';

/**
 * Skip-reason tag a sizing rejection carries so the no-silent-failure
 * invariant holds for cases that look like a hung strategy from outside;
 * downstream metrics key on each tag.
 */
export type SizeSkipReason =
  'min-qty' | 'min-notional' | 'invalid-filters' | 'entry-below-stop-notional';

type SizeResult = { readonly quantity: string } | { readonly skip: SizeSkipReason };

/**
 * Entry quantity for the configured quote-asset budget under Binance's
 * per-symbol filters. Returns a typed skip rather than throwing so the tick
 * handler emits the matching metric. `new Decimal()` throws on malformed
 * input, treated as `invalid-filters`.
 * @param quoteAmount - The quote-asset budget available for this entry.
 * @param currentPrice - The current price used to convert the quote budget into base-asset quantity.
 * @param filters - The symbol filters that constrain the rounded quantity and resulting notional.
 * @param stop - The initial stop distance and limit offset, or null when no stop is configured, so no sellability floor applies.
 * @returns The rounded entry quantity, or a typed skip when the filters, inputs, or stop floor reject it.
 */
export const computeEntryQuantity = (
  quoteAmount: string,
  currentPrice: string,
  filters: SymbolFilters,
  stop: EntryStopFloor | null,
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
  const sized = finalise(quantity, price, parsed);
  if ('skip' in sized) return sized;
  const stopChecked = applyEntryStopFloor(quantity, price, parsed, stop);
  return 'skip' in stopChecked ? stopChecked : sized;
};

/** Derive the initial stop inputs once so preview and live entry sizing enforce the same sellability floor at the same price. The distance uses the initial ATR stop when available, then the fixed trailing-stop percentage that the open-position resolver would rest when ATR cannot be resolved. A protective-stop offset is used only when it parses to a value strictly inside (0, 1) and the stop will rest a limit leg at all; all other values, and every native trail, fall back to a neutral multiplier.
 * The open-interval rule mirrors the arm's `lte(0) || gte(1)` refusal because an offset for which the arm would never rest a limit leg must not tighten or loosen the entry's sellability floor.
 * @param config - The momentum settings that determine the initial stop distance and protective-stop offset.
 * @param candles - The closed candles used by the initial stop-distance resolver.
 * @param price - The wire-format entry price string used to measure the stop distance.
 * @returns The stop-floor inputs, or null when neither the ATR distance nor the fixed trailing-stop percentage can be resolved.
 */
export const entryStopFloor = (
  config: MomentumConfig,
  candles: readonly Candle[],
  price: string,
): EntryStopFloor | null => {
  const parsedPrice = decOrNull(price);
  // An unparseable price cannot place a stop, and computeEntryQuantity must report invalid-filters as before this guard.
  if (parsedPrice === null || !parsedPrice.gt(0)) return null;
  // The open position's stop resolver falls back to the fixed percentage whenever the ATR level is null, so the entry floor must judge that sellable stop rather than stand down. Risk sizing deliberately does not inherit this fallback because it models the initial ATR distance as a loss divisor, which answers a different question.
  const distanceFraction =
    initialStopDistanceFraction(config, candles, parsedPrice) ??
    unitFraction(decOrNull(config.trailingStopPct));
  if (distanceFraction === null) return null;
  // A native trail rests a STOP_LOSS carrying a quantity and a trailing delta and nothing else: it sells at market when it fires, so there is no limit leg for the exchange minimum to be measured at and the trigger is the only price this floor can judge. Applying the offset there would demand roughly 2% more base at the default 0.98 and refuse marginal entries the stop could in fact sell. Same accessor and same absent-key reading as the arm, which treats a missing `mode` as `priced`, so a stored config saved before the leaf existed keeps the offset it has always had.
  const nativeTrail = config.protectiveStop?.mode === 'native-trail';
  const parsedOffset =
    config.protectiveStop?.enabled === true && !nativeTrail
      ? decOrNull(config.protectiveStop.limitOffsetPercentage ?? DEFAULT_LIMIT_OFFSET)
      : null;
  const limitOffset =
    parsedOffset !== null && parsedOffset.gt(0) && parsedOffset.lt(1)
      ? parsedOffset
      : new Decimal(1);
  return { distanceFraction, limitOffset };
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
