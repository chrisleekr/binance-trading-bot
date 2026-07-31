// MarketDataPort — the in-process abstraction over Binance's kline feed.
//
// Every consumer that needs candles (the technicals-compute cron, the tick
// path's cold-load, the IndicatorComputer's window seed) reads through this
// one port. Production wires a `KlineFetcher` adapter that shares a single
// REST cold-start + WS subscription per `(symbol, interval)` across every
// caller; tests wire `FakeMarketDataPort` which pushes scripted closed
// candles into a queue.
//
// The port DOES NOT take a profile scope — kline data is per-symbol, not
// per-profile. Reference-counting by `(symbol, interval)` is the adapter's
// job; callers just subscribe and unsubscribe.

import type { Candle } from '@app/strategy-core';

/**
 * A Binance candle (kline) that has closed. The port emits closed candles
 * only — a still-forming bar is the producer's problem, not the consumer's.
 * `isClosed: true` is part of the type so the strategy / indicator code
 * cannot accidentally fold an in-flight candle into a running state.
 */
export type ClosedKline = Candle & { readonly isClosed: true };

/**
 * Immutable ordered window of closed klines (oldest first). The port's
 * `loadWindow` returns one of these. Consumers slice / iterate; they must
 * not mutate.
 */
export type KlineWindow = readonly ClosedKline[];

/**
 * Token returned by `subscribeKlines`. Calling `unsubscribe()` releases the
 * caller's reference; once the last subscriber for a `(symbol, interval)`
 * unsubscribes the production adapter tears down the underlying WS / cache
 * entry. Idempotent — multiple calls are safe.
 */
export interface KlineSubscription {
  /**
   * Async iterable of closed klines arriving on the underlying stream.
   * Iteration ends when `unsubscribe()` is called. Each yielded candle is
   * the next CLOSED one — duplicates within an iteration are an adapter
   * bug, not a consumer concern.
   */
  readonly stream: AsyncIterable<ClosedKline>;
  /** Release this caller's reference. Idempotent. */
  unsubscribe(): void;
}

/**
 * A symbol-global mini-ticker event. Binance emits one per `@miniTicker`
 * stream tick (≈1Hz). The port flattens Binance's frame shape into the
 * fields downstream consumers actually use: the symbol, the last trade
 * price, and the producer-side event timestamp.
 */
export interface MiniTicker {
  readonly symbol: string;
  /** Last trade price as a decimal-string. Wire-encoded; consumers parse. */
  readonly closePrice: string;
  /** Producer-side event timestamp (ms since epoch). */
  readonly eventTimeMs: number;
}

/**
 * Token returned by `subscribeMiniTicker`. Mirrors {@link KlineSubscription}
 * but yields {@link MiniTicker} frames. `unsubscribe()` is idempotent.
 */
export interface MiniTickerSubscription {
  readonly stream: AsyncIterable<MiniTicker>;
  unsubscribe(): void;
}

/**
 * The in-process market-data port. Producers (the kline fetcher) and
 * consumers (technicals, tick, IndicatorComputer) exchange klines through
 * this single shape. v1.0 ships one production adapter (`KlineFetcher`)
 * and one test adapter (`FakeMarketDataPort`); a future second exchange
 * would satisfy the same shape.
 */
export interface MarketDataPort {
  /**
   * Subscribe to the closed-candle stream for one `(symbol, interval)`.
   * The production adapter shares a single REST + WS subscription across
   * every caller for the same key, ref-counted on subscribe / unsubscribe.
   * Subscribing returns immediately; closed klines arrive on `stream`.
   */
  subscribeKlines(symbol: string, interval: string): KlineSubscription;
  /**
   * Cold-load up to `size` closed klines (newest at the end). Used to
   * warm IndicatorComputer state on first access for a `(symbol, interval)`
   * key — the production adapter pulls from the in-memory ring cache the
   * subscription maintains, falling back to a REST `getKlines` call when
   * the ring is shorter than requested.
   */
  loadWindow(symbol: string, interval: string, size: number): Promise<KlineWindow>;
  /**
   * Subscribe to the per-symbol mini-ticker stream. Like
   * {@link subscribeKlines}, the production adapter multiplexes every
   * subscriber for one symbol over the same underlying WS subscription;
   * subscriber count is ref-counted on subscribe / unsubscribe. The
   * stream yields a {@link MiniTicker} per Binance event (≈1Hz).
   */
  subscribeMiniTicker(symbol: string): MiniTickerSubscription;
}
