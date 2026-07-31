import { z } from 'zod';
import { DecimalString } from './decimal.js';
import { EntryBlockerResponse } from './entry-blocker.js';
import { OPERATOR_ACTIONS } from './operator-actions.js';

/** Binance order side. Upper-case to match Binance's REST/WS payloads exactly so we never re-normalise on the boundary. */
export const OrderSide = z.enum(['BUY', 'SELL']);
/** TS type derived from {@link OrderSide} so consumers don't re-run z.infer at every call site. */
export type OrderSide = z.infer<typeof OrderSide>;

/**
 * Why an order was placed. A strategy-owned, namespaced string (e.g. TT's
 * `grid-buy`/`grid-sell`, a momentum strategy's `entry`/`exit`, or the shared
 * `manual`). The contract does not enumerate it — each strategy owns its
 * vocabulary and `orders.intent` carries no CHECK — so a second strategy's
 * orders are not rejected at the DB boundary. Drives operator-facing labels
 * and decides which audit/notify hooks fire.
 */
export const OrderIntent = z.string().min(1);
/** TS type derived from {@link OrderIntent} so consumers don't re-run z.infer at every call site. */
export type OrderIntent = z.infer<typeof OrderIntent>;

/**
 * Single-order REST response. `raw` carries the original Binance payload as
 * an opaque blob so downstream consumers can read fields we haven't typed
 * yet, without forcing schema churn whenever Binance adds a property.
 */
export const OrderResponse = z.object({
  id: z.uuid(),
  symbol: z.string(),
  side: OrderSide,
  intent: OrderIntent,
  binanceOrderId: z.string(),
  clientOrderId: z.string(),
  status: z.string(),
  raw: z.unknown(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
});
/** TS type derived from {@link OrderResponse} so consumers don't re-run z.infer at every call site. */
export type OrderResponse = z.infer<typeof OrderResponse>;

/** Paginated order list. Cursor-based to keep large historical pages stable under concurrent inserts. */
export const OrderList = z.object({
  items: z.array(OrderResponse),
  nextCursor: z.string().optional(),
});
/** TS type derived from {@link OrderList} so consumers don't re-run z.infer at every call site. */
export type OrderList = z.infer<typeof OrderList>;

/**
 * Per-symbol state shape returned by `GET /symbols/:symbol/state`,
 * consumed by the SPA's symbol view.
 */
export const SymbolStateResponse = z.object({
  /**
   * The profile's strategy identity plus its current config and state.
   * `config` and `state` are opaque here because the contracts package is
   * strategy-agnostic; the web revives them against the owning strategy's
   * schema. The symbol page derives the grid ladder from these — the buy
   * ladder from the strategy config, its live progress from the state —
   * rather than from a persisted table that the running strategy never
   * wrote.
   */
  strategy: z.object({
    name: z.string(),
    config: z.unknown(),
    state: z.unknown(),
    // The operator actions this profile's strategy honors. The symbol screen
    // gates its operator-action panels off this set so a control whose write
    // the strategy would silently drop never renders. Injected at the api
    // boundary from the strategy's `capabilities.operatorActions`.
    operatorActions: z.array(z.enum(OPERATOR_ACTIONS)),
  }),
  avgEntryPrice: z
    .object({
      avgEntryPrice: DecimalString,
      quantity: DecimalString,
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
  openOrders: z.array(OrderResponse),
  /**
   * Per-symbol disable state derived from the `disable-action:<symbol>`
   * Redis key. `null` when the symbol is not disabled. `ttlSeconds` is the
   * remaining TTL at response time so the client can render a countdown
   * without re-querying TTL on every tick. The kill-switch is fully
   * recoverable: a Resume click deletes the key and the strategy resumes.
   */
  disable: z
    .object({
      ttlSeconds: z.number().int().nonnegative(),
      since: z.iso.datetime(),
      reason: z.string(),
    })
    .nullable(),
  /** See {@link EntryBlockerResponse}: structured "why isn't this symbol buying" record. */
  entryBlocker: EntryBlockerResponse,
  /**
   * Why the exchange-side protective stop is NOT armed on an OPEN position, or
   * null. Same shape as {@link EntryBlockerResponse} and read from the same
   * persisted strategy state, but a different question — and the more urgent one:
   * a running position with no stop is unprotected. `.default(null)` keeps
   * payloads written before the field existed decodable.
   */
  protectiveStopBlocker: EntryBlockerResponse.default(null),
});
/** TS type derived from {@link SymbolStateResponse} so consumers don't re-run z.infer at every call site. */
export type SymbolStateResponse = z.infer<typeof SymbolStateResponse>;

/**
 * One OHLCV bar from `GET /profiles/:id/symbols/:symbol/candles`. Strings,
 * not numbers, so JSON survives the wire without IEEE-754 truncation; the
 * web client converts to numbers only at the chart-rendering boundary.
 */
export const CandlePoint = z.object({
  time: z.iso.datetime(),
  open: DecimalString,
  high: DecimalString,
  low: DecimalString,
  close: DecimalString,
  volume: DecimalString,
});
/** TS type derived from {@link CandlePoint} so consumers don't re-run z.infer at every call site. */
export type CandlePoint = z.infer<typeof CandlePoint>;

/** Response array for the candles endpoint. Inline z.array kept here so route + client share one schema. */
export const CandleList = z.array(CandlePoint);
/** TS type derived from {@link CandleList} so consumers don't re-run z.infer at every call site. */
export type CandleList = z.infer<typeof CandleList>;

/**
 * 24-hour rolling-window market statistics for one symbol, from
 * `GET /profiles/:id/symbols/:symbol/ticker`. Proxies Binance's public
 * `/api/v3/ticker/24hr`. Strings, not numbers, so JSON survives the wire
 * without IEEE-754 truncation; the web client converts to numbers only at
 * the display-formatting boundary. `priceChangePercent` is a whole-percent
 * value (Binance's convention: `2.5` means +2.5%).
 */
export const Ticker24hr = z.object({
  symbol: z.string(),
  lastPrice: DecimalString,
  priceChange: DecimalString,
  priceChangePercent: DecimalString,
  highPrice: DecimalString,
  lowPrice: DecimalString,
  openPrice: DecimalString,
  volume: DecimalString,
  quoteVolume: DecimalString,
});
/** TS type derived from {@link Ticker24hr} so consumers don't re-run z.infer at every call site. */
export type Ticker24hr = z.infer<typeof Ticker24hr>;

/**
 * One recent public trade for a symbol, proxied live from Binance's unsigned
 * `/api/v3/trades`. `price`/`qty` are decimal-strings; `time` is ISO-8601.
 * `isBuyerMaker` true means the buyer rested on the book and a sell-side
 * taker hit it — the recent-trades panel colours the row red for that.
 */
export const RecentTrade = z.object({
  id: z.number(),
  price: DecimalString,
  qty: DecimalString,
  quoteQty: DecimalString,
  time: z.iso.datetime(),
  isBuyerMaker: z.boolean(),
});
/** TS type derived from {@link RecentTrade} so consumers don't re-run z.infer at every call site. */
export type RecentTrade = z.infer<typeof RecentTrade>;

/** Ordered list of recent trades, newest last — the `/symbols/{sym}/trades` response. */
export const RecentTradeList = z.array(RecentTrade);
/** TS type derived from {@link RecentTradeList} so consumers don't re-run z.infer. */
export type RecentTradeList = z.infer<typeof RecentTradeList>;

/** One resting order-book level — a price and the aggregate quantity at it, both decimal-strings. */
export const OrderBookLevel = z.object({
  price: DecimalString,
  qty: DecimalString,
});
/** TS type derived from {@link OrderBookLevel}. */
export type OrderBookLevel = z.infer<typeof OrderBookLevel>;

/**
 * Order-book depth for a symbol, proxied live from Binance's unsigned
 * `/api/v3/depth`. `bids` descend in price (best bid first); `asks` ascend
 * (best ask first) — the order-book panel renders asks above bids with the
 * spread between them.
 */
export const OrderBook = z.object({
  bids: z.array(OrderBookLevel),
  asks: z.array(OrderBookLevel),
});
/** TS type derived from {@link OrderBook} so consumers don't re-run z.infer. */
export type OrderBook = z.infer<typeof OrderBook>;
