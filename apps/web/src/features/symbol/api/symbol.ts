import {
  CandleList,
  ManualOrderResponse,
  OrderBook,
  OrderList,
  OverrideActionResponse,
  ProfileSymbolResponse,
  RecentTradeList,
  SymbolLogList,
  SymbolStateResponse,
  Ticker24hr,
  TriggerResponse,
  type CancelOrderRequest,
  type ManualOrderRequest,
  type ManualOrderResponse as ManualOrderResponseT,
  type OverrideActionResponse as OverrideActionResponseT,
  type ProfileSymbolResponse as ProfileSymbolResponseT,
  type SymbolDisableRequest,
  type SymbolLogEntry,
  type TriggerResponse as TriggerResponseT,
} from '@app/contracts';
import { z } from 'zod';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * Internal helper — both `profileId` and `symbol` are interpolated into URLs
 * across this module, so encoding once keeps the call sites readable and
 * guarantees we never ship a malformed path because someone forgot to wrap it.
 */
const symbolPath = (profileId: string, symbol: string, suffix: string): string =>
  accountPath(
    `/profiles/${encodePathSegment(profileId)}/symbols/${encodePathSegment(symbol)}${suffix}`,
  );

const NoBody = z.unknown();

/**
 * Chart interval options offered in the UI selector — the Binance-style tabs.
 * All six are fixed-duration intervals (no calendar-month / week variability),
 * so a static millisecond map sizes the request window exactly.
 */
export const CANDLE_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

/** Millisecond span of each supported interval. */
const CANDLE_INTERVAL_MS: Record<CandleInterval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** Millisecond span of one candle at the given interval. */
export const intervalSpanMs = (interval: CandleInterval): number => CANDLE_INTERVAL_MS[interval];

/** Default chart interval on first paint. */
export const SYMBOL_CANDLE_INTERVAL: CandleInterval = '1m';

/**
 * Default candle window. 240 frames at the chosen interval keeps the chart
 * bundle (lightweight-charts ≈ 200kB gz) feeding from a small payload —
 * operators only need a recent slice; deeper history belongs to /audit.
 */
export const SYMBOL_CANDLE_FRAMES = 240;

/**
 * Read the live trading state for one symbol — grid ladder, average entry price,
 * open orders. The shape mirrors what the worker emits in WS frames so the
 * route can reuse the same renderer for both the initial load and incremental
 * updates without a translation layer.
 */
export const fetchSymbolState = (profileId: string, symbol: string): Promise<SymbolStateResponse> =>
  apiFetch(symbolPath(profileId, symbol, '/state'), SymbolStateResponse, {
    method: 'GET',
  });

/**
 * Schedule a cancel for an open order on this symbol. The API enqueues the
 * cancel and returns immediately; the actual Binance call happens in the
 * worker so a slow upstream cannot stall the operator's click. The route
 * reflects pending state via the open-orders refetch, not the response body.
 */
export const cancelOrder = (
  profileId: string,
  symbol: string,
  body: CancelOrderRequest,
): Promise<unknown> =>
  apiFetch(symbolPath(profileId, symbol, '/cancel-order'), NoBody, {
    method: 'POST',
    body,
  });

/** Stable query key for symbol state. */
export const symbolStateQueryKey = (profileId: string, symbol: string): readonly unknown[] => [
  'profile',
  'symbol',
  'state',
  profileId,
  symbol,
];

/**
 * Compute the candle-window bucket for a given interval and `now`. Bucketing
 * to the interval boundary (not always the minute) keeps the request URL
 * stable across sub-second renders, so React Query caches by
 * `(profileId, symbol, interval, bucketMs)` instead of refetching every
 * render. Exported so the route and the query key derive the same value.
 */
export const symbolCandleBucketMs = (
  interval: CandleInterval = SYMBOL_CANDLE_INTERVAL,
  now: Date = new Date(),
): number => {
  const span = CANDLE_INTERVAL_MS[interval];
  return Math.floor(now.getTime() / span) * span;
};

/**
 * Read OHLCV bars for the chart panel.
 *
 * The window is bucketed to the interval boundary so the URL is stable across
 * sub-second renders; React Query caches by `(profileId, symbol, interval,
 * bucketMs)` which means re-rendering inside the same bucket hits the cache
 * rather than Binance. The caller can pass a fixed `now` (used by tests and
 * to share the bucket with `symbolCandlesQueryKey`).
 */
export const fetchSymbolCandles = (
  profileId: string,
  symbol: string,
  options: { interval?: CandleInterval; frames?: number; now?: Date } = {},
): Promise<CandleList> => {
  const interval = options.interval ?? SYMBOL_CANDLE_INTERVAL;
  const frames = options.frames ?? SYMBOL_CANDLE_FRAMES;
  const bucketMs = symbolCandleBucketMs(interval, options.now);
  const fromMs = bucketMs - frames * CANDLE_INTERVAL_MS[interval];
  return apiFetch(
    accountPath(
      `/profiles/${encodePathSegment(profileId)}/symbols/${encodePathSegment(symbol)}/candles`,
    ),
    CandleList,
    {
      method: 'GET',
      query: {
        interval,
        from: new Date(fromMs).toISOString(),
        to: new Date(bucketMs).toISOString(),
      },
    },
  );
};

/**
 * Query key for symbol candles. Keyed on the interval and its window bucket
 * so switching interval re-queries while a re-render inside the same bucket
 * reuses the cache. Pair `bucketMs` with `symbolCandleBucketMs(interval, now)`
 * so the key and the request URL stay aligned.
 */
export const symbolCandlesQueryKey = (
  profileId: string,
  symbol: string,
  interval: CandleInterval,
  bucketMs: number,
): readonly unknown[] => ['profile', 'symbol', 'candles', profileId, symbol, interval, bucketMs];

/**
 * Read the 24-hour rolling market statistics for one symbol — last price,
 * absolute and percentage change, high/low, base and quote volume. Powers
 * the Binance-style ticker strip in the symbol-detail header. Exchange-global
 * market data proxied live from Binance, not account-scoped state.
 */
export const fetchSymbolTicker = (profileId: string, symbol: string): Promise<Ticker24hr> =>
  apiFetch(symbolPath(profileId, symbol, '/ticker'), Ticker24hr, { method: 'GET' });

/** Stable query key for the 24h ticker. */
export const symbolTickerQueryKey = (profileId: string, symbol: string): readonly unknown[] => [
  'profile',
  'symbol',
  'ticker',
  profileId,
  symbol,
];

/** 24h stats drift slowly; a 30s poll keeps the readout live without hammering Binance. */
const TICKER_REFETCH_MS = 30_000;

/**
 * Shared options for the 24h ticker.
 *
 * The stats strip renders `lastPrice` and the workspace marks the position's
 * unrealised P/L against it. Both go through here so they read one cache entry:
 * separate queries would let the two drift a refetch apart, which is how a P/L
 * came to be marked at a price the header directly above it was not showing.
 *
 * The trade panel is a third reader on the same key, but keeps its own faster
 * interval so the manual-order form's price tracks its balances refresh.
 */
export const symbolTickerQuery = (profileId: string, symbol: string) => ({
  queryKey: symbolTickerQueryKey(profileId, symbol),
  queryFn: () => fetchSymbolTicker(profileId, symbol),
  refetchInterval: TICKER_REFETCH_MS,
  staleTime: TICKER_REFETCH_MS,
});

/**
 * Read the most recent public trades for one symbol — price, quantity, time,
 * taker side. Powers the Binance-style recent-trades panel. The endpoint
 * proxies Binance's public `/api/v3/trades` (unsigned; testnet/live host by
 * `profile.binanceMode`) — exchange-global market data, not persisted, same
 * pattern as the candles and 24h-ticker proxies.
 */
export const fetchSymbolRecentTrades = (
  profileId: string,
  symbol: string,
): Promise<RecentTradeList> =>
  apiFetch(symbolPath(profileId, symbol, '/trades'), RecentTradeList, { method: 'GET' });

/** Stable query key for the recent-trades list. */
export const symbolRecentTradesQueryKey = (
  profileId: string,
  symbol: string,
): readonly unknown[] => ['profile', 'symbol', 'trades', profileId, symbol];

/**
 * Read the current order-book depth for one symbol — resting bid and ask
 * levels. Powers the Binance-style order-book panel. The endpoint proxies
 * Binance's public `/api/v3/depth` (unsigned; testnet/live host by
 * `profile.binanceMode`) — exchange-global market data, not persisted, same
 * pattern as the candles, ticker and recent-trades proxies.
 */
export const fetchSymbolOrderBook = (profileId: string, symbol: string): Promise<OrderBook> =>
  apiFetch(symbolPath(profileId, symbol, '/depth'), OrderBook, { method: 'GET' });

/** Stable query key for the order book. */
export const symbolOrderBookQueryKey = (profileId: string, symbol: string): readonly unknown[] => [
  'profile',
  'symbol',
  'depth',
  profileId,
  symbol,
];

/**
 * Read this symbol's recent order history — the operator's own filled and
 * cancelled orders, newest first, persisted in Postgres (distinct from the
 * live open-orders set on `SymbolStateResponse` and from the public market
 * trades on `/trades`). Powers the Order history panel.
 */
export const fetchSymbolOrderHistory = (profileId: string, symbol: string): Promise<OrderList> =>
  apiFetch(symbolPath(profileId, symbol, '/orders'), OrderList, { method: 'GET' });

/** Stable query key for the order-history list. */
export const symbolOrderHistoryQueryKey = (
  profileId: string,
  symbol: string,
): readonly unknown[] => ['profile', 'symbol', 'orders', profileId, symbol];

/**
 * Default initial-load window for the action-logs panel. The route is bounded
 * by `from`/`to`, so a 24h window keeps the first paint cheap; older history
 * arrives by the operator clicking "Load older", which widens `from` further.
 */
export const SYMBOL_LOGS_INITIAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Each "Load older" click extends `from` backwards by this much. */
export const SYMBOL_LOGS_PAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * Hard cap on rows the panel keeps in memory. The virtualised list drops
 * older rows past this cap so a hot WS topic cannot grow the array without
 * bound. 1k balances memory footprint against scroll depth on a mobile
 * viewport and keeps the per-frame `Set`-based row-key de-dup cheap.
 */
export const SYMBOL_LOGS_RING_CAP = 1_000;

/**
 * Read action-log entries for one symbol, bounded by `[from, to)`.
 *
 * The caller owns the window — initial paint is a 24h slice, "Load older"
 * widens it. Keeping the window-decision client-side means the route can
 * merge older pages into a single virtualised list without the server having
 * to be aware of an unbounded scroll position.
 */
export const fetchSymbolLogs = (
  profileId: string,
  symbol: string,
  range: { from: Date; to: Date },
): Promise<SymbolLogList> => {
  return apiFetch(
    accountPath(
      `/profiles/${encodePathSegment(profileId)}/symbols/${encodePathSegment(symbol)}/logs`,
    ),
    SymbolLogList,
    {
      method: 'GET',
      query: { from: range.from.toISOString(), to: range.to.toISOString() },
    },
  );
};

/**
 * Stable query key for the *initial* logs window. We only key on the symbol
 * pair — the window is computed deterministically from `now`, and we don't
 * want the cache fragmented by sub-second drift. Older pages are loaded by
 * imperative `queryClient.fetchQuery` calls and merged into local state.
 */
export const symbolLogsQueryKey = (profileId: string, symbol: string): readonly unknown[] => [
  'profile',
  'symbol',
  'logs',
  profileId,
  symbol,
];

/** Re-exported so the panel can talk in the contract type without importing the contracts barrel. */
export type { SymbolLogEntry };

/**
 * POST /profiles/:id/symbols/:symbol/manual-order — schedules a single-symbol
 * manual order. The worker picks the override action up via the override-
 * actions stream; the response only confirms the schedule, not the fill.
 */
export const submitManualOrder = (
  profileId: string,
  symbol: string,
  body: ManualOrderRequest,
): Promise<ManualOrderResponseT> =>
  apiFetch(symbolPath(profileId, symbol, '/manual-order'), ManualOrderResponse, {
    method: 'POST',
    body,
  });

/**
 * POST /profiles/:id/symbols/:symbol/disable — engages the per-symbol
 * kill-switch for `ttlSeconds`, freezing the strategy's decisions for this
 * symbol until the TTL expires or the operator resumes. Returns 204; no body.
 */
export const engageDisable = (
  profileId: string,
  symbol: string,
  body: SymbolDisableRequest,
): Promise<unknown> =>
  apiFetch(symbolPath(profileId, symbol, '/disable'), NoBody, {
    method: 'POST',
    body,
  });

/**
 * DELETE /profiles/:id/symbols/:symbol/disable — releases the per-symbol
 * kill-switch immediately. Returns 204; no body.
 */
export const releaseDisable = (profileId: string, symbol: string): Promise<unknown> =>
  apiFetch(symbolPath(profileId, symbol, '/disable'), NoBody, {
    method: 'DELETE',
  });

/**
 * POST /profiles/:id/symbols/:symbol/archive-grid-trade — schedules a worker
 * job that closes the open grid, archives realised P/L, and notifies Slack.
 */
export const archiveGridTrade = (profileId: string, symbol: string): Promise<unknown> =>
  apiFetch(symbolPath(profileId, symbol, '/archive-grid-trade'), NoBody, {
    method: 'POST',
  });

/**
 * POST /profiles/:id/symbols/:symbol/reset-grid-trade — clears the grid
 * row so the strategy rebuilds the ladder from current price on next tick.
 */
export const resetGridTrade = (profileId: string, symbol: string): Promise<unknown> =>
  apiFetch(symbolPath(profileId, symbol, '/reset-grid-trade'), NoBody, {
    method: 'POST',
  });

/**
 * GET /profiles/:id/symbols/:symbol — read the per-symbol config override.
 * `overrideConfig` is `null` when the symbol inherits the profile config.
 */
export const fetchSymbolOverride = (
  profileId: string,
  symbol: string,
): Promise<ProfileSymbolResponseT> =>
  apiFetch(symbolPath(profileId, symbol, ''), ProfileSymbolResponse, { method: 'GET' });

/**
 * PATCH /profiles/:id/symbols/:symbol — write the per-symbol config override.
 * Pass the partial override config, or `null` to revert the symbol to the
 * profile-level config. The server validates a non-null override against the
 * strategy's `overrideConfigSchema`.
 */
export const patchSymbolOverride = (
  profileId: string,
  symbol: string,
  overrideConfig: Record<string, unknown> | null,
): Promise<ProfileSymbolResponseT> =>
  apiFetch(symbolPath(profileId, symbol, ''), ProfileSymbolResponse, {
    method: 'PATCH',
    body: { overrideConfig },
  });

/** Stable query key for a symbol's config-override row. */
export const symbolOverrideQueryKey = (profileId: string, symbol: string): readonly unknown[] => [
  'profile',
  'symbol',
  'override',
  profileId,
  symbol,
];

/**
 * Drops the per-symbol config override so the symbol falls back to the
 * profile-level config — a `PATCH` with `overrideConfig: null`.
 */
export const resetSymbolConfig = (
  profileId: string,
  symbol: string,
): Promise<ProfileSymbolResponseT> => patchSymbolOverride(profileId, symbol, null);

/**
 * PUT /profiles/:id/symbols/:symbol/avg-entry-price — sets the operator's
 * cost basis. The body carries the LBP as a decimal string; the worker
 * pulls the on-balance quantity from the user-stream snapshot.
 */
export const setAvgEntryPrice = (
  profileId: string,
  symbol: string,
  avgEntryPrice: string,
): Promise<unknown> =>
  apiFetch(symbolPath(profileId, symbol, '/avg-entry-price'), NoBody, {
    method: 'PUT',
    body: { avgEntryPrice },
  });

/**
 * DELETE /profiles/:id/symbols/:symbol/avg-entry-price — clears the LBP so
 * the strategy stops sizing sells against it.
 */
export const deleteAvgEntryPrice = (profileId: string, symbol: string): Promise<unknown> =>
  apiFetch(symbolPath(profileId, symbol, '/avg-entry-price'), NoBody, {
    method: 'DELETE',
  });

/**
 * DELETE /profiles/:id/symbols/:symbol — full symbol wipe. Removes the
 * profile_symbols row, archive entries, avg_entry_price row, and any
 * pending override actions in one transaction. Cascade-confirmed in the UI.
 */
export const wipeSymbol = (profileId: string, symbol: string): Promise<unknown> =>
  apiFetch(symbolPath(profileId, symbol, ''), NoBody, {
    method: 'DELETE',
  });

/**
 * GET /profiles/:id/symbols/:symbol/override — the most recent operator
 * override for the symbol, settled or still pending. `outcome` is null while it
 * is pending and carries the real result once a tick has settled it, which is
 * what turns the optimistic "scheduled" message into the truth.
 */
export const getOverride = (profileId: string, symbol: string): Promise<OverrideActionResponseT> =>
  apiFetch(symbolPath(profileId, symbol, '/override'), OverrideActionResponse);

/**
 * DELETE /profiles/:id/symbols/:symbol/override — revokes the queued override
 * so the next tick does not act on it.
 *
 * A 204 is NOT proof an override existed, and NOT proof the queue is now empty.
 * The route answers it four ways: a row it deleted, a stale claim it evicted, no
 * row at all, and — the case that rules out "nothing is queued now" — a NEWER
 * unclaimed override that landed after the delete and was deliberately left
 * alone. So callers must describe the action taken, never the resulting state.
 *
 * A 409 means a live claim holds the row: the bot is already dispatching it, so
 * the cancel lost the race. It can still be a partial success — the server says
 * so when a queued row was deleted alongside the claimed one, which is why its
 * prose has to reach the operator verbatim rather than being reworded.
 */
export const cancelOverride = (profileId: string, symbol: string): Promise<unknown> =>
  apiFetch(symbolPath(profileId, symbol, '/override'), NoBody, {
    method: 'DELETE',
  });

/** Stable query key for a symbol's latest operator override. */
export const symbolOverrideActionQueryKey = (
  profileId: string,
  symbol: string,
): readonly unknown[] => ['profile', 'symbol', 'override-action', profileId, symbol];

/**
 * POST /profiles/:id/symbols/:symbol/trigger-buy — fires a buy override that
 * runs regardless of the Technicals gate. Body is empty because the server
 * always uses `checkTechnicals: false` on this path.
 */
export const triggerBuy = (profileId: string, symbol: string): Promise<TriggerResponseT> =>
  apiFetch(symbolPath(profileId, symbol, '/trigger-buy'), TriggerResponse, {
    method: 'POST',
  });

/**
 * POST /profiles/:id/symbols/:symbol/trigger-sell — fires a sell override.
 * Server enforces "notify: true" so the operator gets Slack on completion.
 */
export const triggerSell = (profileId: string, symbol: string): Promise<TriggerResponseT> =>
  apiFetch(symbolPath(profileId, symbol, '/trigger-sell'), TriggerResponse, {
    method: 'POST',
  });
