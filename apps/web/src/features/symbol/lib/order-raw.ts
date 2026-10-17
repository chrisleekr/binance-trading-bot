// Order quantity / price live inside the opaque Binance `raw` payload an
// `OrderResponse` carries — the contract keeps `raw` unknown so it does not
// churn whenever Binance adds a property. These readers pull the fields the
// UI shows, falling back to an em-dash when the payload is unexpected.

import { formatPercent, formatPrice } from '@/shared/lib/format';

import type { OrderResponse } from '@app/contracts';

export interface RawOrderShape {
  readonly origQty?: string;
  readonly price?: string;
  readonly type?: string;
  readonly executedQty?: string;
  readonly cummulativeQuoteQty?: string;
  readonly stopPrice?: string;
  /** Binance types the trailing distance a `LONG`, so it arrives as a number, not a decimal-string. */
  readonly trailingDelta?: number;
}

/**
 * Narrows an order's opaque `raw` payload to the fields the UI reads. The
 * field-type checks matter: a payload like `{ origQty: 123 }` must fail the
 * guard so the readers fall back to an em-dash rather than leak a non-string.
 */
export const isRawShape = (v: unknown): v is RawOrderShape => {
  if (typeof v !== 'object' || v === null) return false;
  const raw = v as Record<string, unknown>;
  const isOptString = (key: string): boolean =>
    raw[key] === undefined || typeof raw[key] === 'string';
  return (
    isOptString('origQty') &&
    isOptString('price') &&
    isOptString('type') &&
    isOptString('executedQty') &&
    isOptString('cummulativeQuoteQty') &&
    isOptString('stopPrice') &&
    (raw['trailingDelta'] === undefined || typeof raw['trailingDelta'] === 'number')
  );
};

/** Order quantity from the Binance `raw` payload, or an em-dash. */
export const orderQty = (order: OrderResponse): string =>
  isRawShape(order.raw) ? (order.raw.origQty ?? '—') : '—';

/**
 * The price at which a resting SELL stop-loss fires, or null when the order is not a fixed-price sell stop.
 *
 * A `STOP_LOSS_LIMIT` carries two prices: `stopPrice` (the trigger) and `price` (the worst fill accepted once triggered). The Price column shows the limit, which sits below the trigger, so reading it as "where the stop is" puts the stop further away than it really is. An exchange trailing stop (`trailingDelta`) has no fixed trigger to name, so it returns null rather than a stale number.
 *
 * @param order - Any open order; buy-side and non-stop orders and unexpected payloads return null, because every caller words the result as "sells if price falls to".
 * @returns The trigger price as Binance sent it (a decimal-string), or null.
 */
export const stopTriggerPrice = (order: OrderResponse): string | null => {
  if (order.side !== 'SELL' || !isRawShape(order.raw)) return null;
  const { type, stopPrice, trailingDelta } = order.raw;
  if (type !== 'STOP_LOSS' && type !== 'STOP_LOSS_LIMIT') return null;
  if (trailingDelta !== undefined || stopPrice === undefined || !(Number(stopPrice) > 0))
    return null;
  return stopPrice;
};

/**
 * The limit a SELL stop-limit rests at once it fires, or null when the order has no limit leg.
 *
 * Once a `STOP_LOSS_LIMIT` triggers, Binance places its sell at `price`, and a price that keeps falling past that limit leaves the sell resting unfilled. A `STOP_LOSS` sells at market on trigger, so it has no limit to name.
 *
 * @param order - Any open order; only a fixed-price SELL `STOP_LOSS_LIMIT` (one {@link stopTriggerPrice} names) yields a value.
 * @returns The limit price as Binance sent it (a decimal-string), or null.
 */
export const stopLimitPrice = (order: OrderResponse): string | null => {
  if (stopTriggerPrice(order) === null || !isRawShape(order.raw)) return null;
  const { type, price } = order.raw;
  return type === 'STOP_LOSS_LIMIT' && price !== undefined && Number(price) > 0 ? price : null;
};

/**
 * Whether the current price has reached a SELL stop's trigger, so the stop has fired (or is about to) rather than waiting below.
 *
 * @param trigger - The stop's trigger price, as a decimal-string.
 * @param current - The current market price, or null before it loads.
 * @returns True when the current price is at or below the trigger; false when it is above or either price is unusable.
 */
export const isStopTriggered = (trigger: string, current: string | null | undefined): boolean => {
  const pct = pctFromNow(trigger, current);
  return pct !== null && pct >= 0;
};

/**
 * Percent a price sits from the current price (`-1.2` = 1.2% below).
 *
 * Display-only Number math (apps/web is barred from decimal.js and this never feeds an order).
 *
 * @param price - The level being described, as a decimal-string.
 * @param current - The current market price, or null before it loads.
 * @returns The signed percent, or null when either price is missing or unusable.
 */
export const pctFromNow = (price: string, current: string | null | undefined): number | null => {
  const p = Number(price);
  const c = Number(current);
  if (current == null || !Number.isFinite(p) || !Number.isFinite(c) || c <= 0) return null;
  return (p / c - 1) * 100;
};

/**
 * {@link pctFromNow} in words, `1.20% below now`, so a reader never has to decode a sign.
 *
 * @param price - The level being described, as a decimal-string.
 * @param current - The current market price, or null before it loads.
 * @returns The phrase, or null when either price is missing or unusable.
 */
export const distanceFromNow = (
  price: string,
  current: string | null | undefined,
): string | null => {
  const pct = pctFromNow(price, current);
  if (pct === null) return null;
  return `${formatPercent(Math.abs(pct))} ${pct < 0 ? 'below' : 'above'} now`;
};

/**
 * Display string for the Price column. MARKET orders book at the trade fill
 * price, so the request-side `price` field is "0" — rendering "0" was the
 * operator-confusing behaviour we are replacing. For a filled MARKET order we
 * derive the average fill price from `cummulativeQuoteQty / executedQty`
 * (a display-only Number divide; the result never feeds an order) and render
 * `MKT @ {avg}`. For an unfilled or partially-filled MARKET order with no
 * usable quote total we render bare `MKT`. LIMIT orders fall through to the
 * regular price reader.
 *
 * A `STOP_LOSS` is market-on-trigger, so Binance reports its `price` as zero:
 * there is no limit leg. Rendering that zero would tell the operator their stop
 * sits at a price of nothing, so the type gets its own label. Which label depends
 * on `trailingDelta` — only that field makes the order the exchange-native trail
 * the bot places, and a hand-placed `STOP_LOSS` carries a fixed `stopPrice`
 * instead. Calling that one TRAIL would tell the operator a static stop follows
 * the market.
 *
 * `cummulativeQuoteQty` matches Binance's misspelling on the wire; preserved
 * verbatim so the guard reads the field Binance actually ships.
 */
export const orderDisplayPrice = (order: OrderResponse): string => {
  if (!isRawShape(order.raw)) return '—';
  const raw = order.raw;
  if (raw.type === 'STOP_LOSS') {
    if (raw.trailingDelta !== undefined) return 'TRAIL';
    return raw.stopPrice ? `STOP @ ${formatPrice(raw.stopPrice)}` : 'STOP';
  }
  if (raw.type !== 'MARKET') return raw.price ? formatPrice(raw.price) : '—';
  const executed = Number(raw.executedQty);
  const quote = Number(raw.cummulativeQuoteQty);
  if (Number.isFinite(executed) && Number.isFinite(quote) && executed > 0 && quote > 0) {
    const avg = quote / executed;
    // Post-divide finite check: a sub-normal `executed` could still push the
    // ratio to Infinity, which `formatPrice` would echo back as "Infinity".
    if (Number.isFinite(avg) && avg > 0) return `MKT @ ${formatPrice(String(avg))}`;
  }
  return 'MKT';
};
