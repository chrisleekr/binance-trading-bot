// Order quantity / price live inside the opaque Binance `raw` payload an
// `OrderResponse` carries — the contract keeps `raw` unknown so it does not
// churn whenever Binance adds a property. These readers pull the fields the
// UI shows, falling back to an em-dash when the payload is unexpected.

import { formatPrice } from '@/shared/lib/format';

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
