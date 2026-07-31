// Market-data liveness watchdog.
//
// Tick cadence is 100% WS-frame-driven: a tick is enqueued only when a
// mini-ticker or kline frame arrives. So when the market-data WebSocket drops,
// NO tick fires for any symbol until it reconnects — the strategy goes blind and
// in-process stops / trailing / time-stops / entries freeze for the whole
// reconnect-backoff window (up to ~60s). The exchange-side protective stop
// (opt-in) covers only the hard stop-loss, not the rest.
//
// This watchdog closes that gap: while `isConnected()` is false it REST-polls
// each subscribed symbol's freshest price and feeds it back as a synthetic
// mini-ticker through the SAME `onMarketEvent` path a real frame uses — so the
// strategy keeps evaluating a fresh price during the outage. It is INERT while
// the WS is healthy (the `isConnected()` guard returns immediately), so it adds
// zero steady-state work. Idempotency is inherited from the tick path: the
// synthetic mini-ticker enqueues the same coalesced `tick:<pid>:<sym>` job and
// every decision carries a deterministic clientOrderId, so a safety tick can
// neither double-fire an order nor race the eventual reconnect resync.

import type { Logger } from 'pino';

import type { ParsedMarketEvent } from './types.js';

export interface MarketLivenessWatchdogDeps {
  /** Market-data WS liveness — true when the socket is open. */
  readonly isConnected: () => boolean;
  /** Symbols to keep evaluating during a gap (the live trading set). */
  readonly subscribedSymbols: () => readonly string[];
  /**
   * Freshest last price for a symbol via REST, or null when unavailable. The
   * implementation reserves the per-IP weight budget (bulk, not order-priority)
   * so a gap poll cannot starve order placement.
   */
  readonly fetchPrice: (symbol: string) => Promise<string | null>;
  /** Feed a synthetic event into the event router (the real tick path). */
  readonly feed: (event: ParsedMarketEvent) => Promise<void>;
  /**
   * Milliseconds since the market-data WS last received any frame. Grows
   * without bound when the socket is silently stalled (TCP up, server stopped
   * delivering frames) even though `isConnected()` stays true. Read to detect
   * that stall, which the socket-close-only reconnect path cannot.
   */
  readonly msSinceLastFrame: () => number;
  /**
   * Force the market-data socket closed so its reconnect + resubscribe path
   * rebuilds it. Called once when a stall is detected; flips `isConnected()`
   * false synchronously so the same pass falls through to the REST gap-fill.
   */
  readonly forceReconnect: () => void;
  readonly clock: { nowMs(): number };
  readonly logger: Logger;
}

export interface MarketLivenessWatchdogOptions {
  /** Poll cadence while the WS is down. Default 5s; floored at 1s. */
  readonly intervalMs?: number;
  /**
   * Treat a connected socket with no frame for this long as silently stalled
   * and force a reconnect. Default 20s; floored at 10s. The miniTicker stream
   * pushes ~1/s, so 20s of silence on an actively-subscribed feed is
   * unambiguously dead, while staying well clear of normal frame jitter.
   */
  readonly staleThresholdMs?: number;
}

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
const DEFAULT_STALE_THRESHOLD_MS = 20_000;
const MIN_STALE_THRESHOLD_MS = 10_000;

export interface MarketLivenessWatchdog {
  /** Arm the interval timer. Returns a stop function. Idempotent. */
  start(): () => void;
  /** Disarm the interval timer. */
  stop(): void;
  /** One watchdog pass — exported for deterministic tests. */
  runOnce(): Promise<void>;
}

/**
 * Build the watchdog's `fetchPrice` from a closed-kline fetcher. The latest 1m
 * bar is still forming, and the closed-kline fetcher drops it (its close time is
 * in the future), so a `limit:1` request returns an EMPTY array — request 2 to
 * get the last CLOSED 1m bar. Returns its close, or null when no closed bar is
 * available. Extracted (and `limit` named) so this — the exact off-by-one that
 * a stubbed `fetchPrice` would mask — is unit-tested.
 */
export const GAP_PRICE_KLINE_LIMIT = 2;

export const createKlineGapPriceFetcher =
  (
    fetchKlines: (req: {
      symbol: string;
      interval: string;
      limit: number;
    }) => Promise<readonly { readonly close: string }[]>,
  ): ((symbol: string) => Promise<string | null>) =>
  async (symbol) => {
    const klines = await fetchKlines({ symbol, interval: '1m', limit: GAP_PRICE_KLINE_LIMIT });
    return klines.at(-1)?.close ?? null;
  };

export const createMarketLivenessWatchdog = (
  deps: MarketLivenessWatchdogDeps,
  options?: MarketLivenessWatchdogOptions,
): MarketLivenessWatchdog => {
  const intervalMs = Math.max(options?.intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
  const staleThresholdMs = Math.max(
    options?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS,
    MIN_STALE_THRESHOLD_MS,
  );
  let timer: ReturnType<typeof setInterval> | null = null;

  const runOnce = async (): Promise<void> => {
    const symbols = deps.subscribedSymbols();
    // Silent-stall detection: the socket reports connected but no frame has
    // arrived within the stale threshold while we have live subscriptions (so
    // frames are expected). The close-only reconnect path can't see this, so
    // force a reconnect. forceReconnect flips isConnected() false synchronously,
    // so the gap-fill below runs in this same pass and keeps the strategy fed
    // until the new socket is up. Skipped when no symbols are subscribed (no
    // frames are expected, so silence is not a stall).
    const idleMs = deps.msSinceLastFrame();
    if (deps.isConnected() && symbols.length > 0 && idleMs > staleThresholdMs) {
      deps.logger.warn(
        { msSinceLastFrame: idleMs, staleThresholdMs },
        'market-liveness watchdog: feed stalled while socket open; forcing reconnect',
      );
      deps.forceReconnect();
    }
    // Inert while healthy: real frames already drive ticks. Only act in a gap
    // (a genuine disconnect, or the reconnect just forced above).
    if (deps.isConnected()) return;
    await Promise.all(
      symbols.map(async (symbol) => {
        try {
          const price = await deps.fetchPrice(symbol);
          if (price === null) return;
          await deps.feed({
            kind: 'mini-ticker',
            symbol,
            closePrice: price,
            eventTimeMs: deps.clock.nowMs(),
          });
        } catch (err) {
          // One symbol's poll failing must not abort the others or throw out of
          // the timer callback; the next pass retries.
          deps.logger.warn({ symbol, err: err }, 'market-liveness watchdog: gap price poll failed');
        }
      }),
    );
  };

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    start() {
      // Idempotent: replace any existing timer rather than stacking.
      stop();
      timer = setInterval(() => void runOnce(), intervalMs);
      // `unref` lets the worker exit cleanly with the timer armed (Node-only).
      const t = timer as unknown as { unref?: () => void };
      t.unref?.();
      return stop;
    },
    stop,
    runOnce,
  };
};
