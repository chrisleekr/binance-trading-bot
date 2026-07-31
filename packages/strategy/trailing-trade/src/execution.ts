import { Decimal, roundToStep, toFixedStep } from '@app/money';
import type { TickInput } from '@app/strategy-core';
import { safeDecimal } from './branches/safe-decimal.js';
import type { TTBundle, TTConfig, TTState } from './schema.js';

/**
 * Passive maker buy-limit price for a strategy entry, or `undefined` when the
 * profile is in `market` (taker) entry mode or the price / tick cannot be
 * parsed (then the caller keeps the MARKET order). Rests `makerOffsetBps` below
 * the current price so the order posts liquidity instead of crossing the
 * spread; it fills as a maker only if the price reaches it.
 *
 * Reads `config.execution` defensively (`?.`) because the worker passes RAW
 * stored config: a row written before this field existed reads as `market`
 * mode and returns `undefined`, byte-identical to the pre-maker behaviour
 * (golden-replay diff = 0). The price is rounded to the symbol tick so the
 * exchange accepts it.
 */
export const resolveMakerEntryLimit = (
  input: TickInput<TTConfig, TTState, TTBundle>,
): string | undefined => {
  if (input.config.execution?.entryMode !== 'maker') return undefined;
  const filters = input.market.symbolInfo.filters;
  const price = safeDecimal(input.market.currentPrice);
  const offsetBps = safeDecimal(input.config.execution.makerOffsetBps ?? '0');
  const tick = safeDecimal(filters.tickSize);
  if (price === null || offsetBps === null || tick === null || tick.lte(0)) return undefined;
  // currentPrice × (1 − offsetBps/10000): rest below the market by the offset so
  // the limit does not cross. A zero offset rests at the current price.
  const rounded = roundToStep(price.mul(new Decimal(1).minus(offsetBps.div(10_000))), tick);
  // Guard AFTER rounding: a sub-tick price floors to 0, and Binance rejects a
  // price below the symbol minPrice. Either way return undefined so the caller
  // falls back to a MARKET buy — the entry still executes, it just is not maker.
  const minPrice = safeDecimal(filters.minPrice);
  if (rounded.lte(0) || (minPrice !== null && minPrice.gt(0) && rounded.lt(minPrice))) {
    return undefined;
  }
  return toFixedStep(rounded, tick);
};
