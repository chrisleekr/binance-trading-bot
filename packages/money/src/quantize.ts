import Decimal from 'decimal.js';

/**
 * Quantize a value down to the nearest multiple of `step`. Used for Binance
 * `LOT_SIZE` quantities where the exchange rejects anything not aligned to
 * `stepSize`. Floors rather than rounds so the result never exceeds the
 * requested input — overspending would breach the operator's max-purchase.
 */
export const roundToStep = (value: Decimal, step: Decimal): Decimal => {
  if (step.lte(0)) {
    throw new Error('@app/money/roundToStep: step must be positive');
  }
  return value.div(step).floor().mul(step);
};

/**
 * Quantize a price down to the nearest multiple of `tickSize`. Mirror of
 * {@link roundToStep} for Binance `PRICE_FILTER`. Same flooring rationale:
 * a price above the requested would change the order's economics.
 */
export const roundToTick = (price: Decimal, tickSize: Decimal): Decimal => {
  if (tickSize.lte(0)) {
    throw new Error('@app/money/roundToTick: tickSize must be positive');
  }
  return price.div(tickSize).floor().mul(tickSize);
};

/**
 * Whether `quantity * price` meets Binance's `MIN_NOTIONAL` filter. Returning
 * a boolean (not a Decimal) keeps callers from re-implementing the threshold
 * comparison and accidentally allowing a sub-notional order through.
 */
export const meetsMinNotional = (
  quantity: Decimal,
  price: Decimal,
  minNotional: Decimal,
): boolean => quantity.mul(price).gte(minNotional);
