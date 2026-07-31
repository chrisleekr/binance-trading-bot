// MarketSubscriptionsManager — translates the MarketDataPort's
// per-`(symbol, interval)` subscription model into the event-router's
// push-based onMarketEvent contract.
//
// For each profile-trading symbol the worker subscribes the UNION of its
// profiles' feed intervals (each profile claims `feedIntervals(candleInterval)`:
// its trading interval + `1m` freshness + `1d` ATH/regime) plus one mini-ticker.
// Each WS kline stream is refcounted by the number of profile claims: the
// stream opens on the first claim (0→1) and closes only when its last claimant
// leaves (→0). So two profiles trading the same symbol on different intervals
// each get their own interval's stream, while a shared interval (1m/1d, or two
// profiles on the same trading interval) is opened once and refcounted. The
// mini-ticker lives as long as any kline interval does for the symbol.
//
// Each subscription's `stream` is consumed by an async loop that pushes
// onMarketEvent into the existing event-router.

import type { Logger } from 'pino';
import type {
  ClosedKline,
  KlineSubscription,
  MarketDataPort,
  MiniTicker,
  MiniTickerSubscription,
} from '@app/binance';

import type { ParsedMarketEvent } from './types.js';
import { feedIntervals } from './feed-intervals.js';

export interface MarketSubscriptionsManagerOptions {
  readonly port: MarketDataPort;
  readonly onMarketEvent: (event: ParsedMarketEvent) => Promise<void>;
  /**
   * Called per active symbol when the underlying market-data WS reconnects.
   * Mirrors the original `MarketDataSubscriber.onResync` semantics: the
   * event-router translates the call into a `resync` tick per profile so
   * any state computed during the disconnect window is recomputed against
   * authoritative state.
   */
  readonly onResync: (symbol: string) => Promise<void>;
  /**
   * Drop the per-(symbol, interval) in-memory indicator state when its last
   * claim is released. Without this the IndicatorComputer's state Map keeps an
   * entry for every symbol ever traded for the worker's whole uptime — a slow
   * unbounded climb under discovery churn. Mirrors the kline-ring drop that
   * happens on the same unsubscribe. Best-effort: a failure must not block
   * teardown. Optional so tests/callers that don't wire it keep prior behaviour.
   */
  readonly clearIndicatorState?: (symbol: string, interval: string) => Promise<void>;
  readonly logger: Logger;
}

export interface MarketSubscriptionsManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  addSymbols(symbols: readonly string[], candleInterval: string): Promise<void>;
  removeSymbols(symbols: readonly string[], candleInterval: string): Promise<void>;
  /** Inspection hook for tests + ops. */
  subscribedSymbols(): readonly string[];
}

interface SymbolHandle {
  // One entry per active interval for this symbol, refcounted by the number of
  // profile claims. A profile claim is feedIntervals(candleInterval): its
  // trading interval + 1m + 1d. The interval's WS sub is opened on 0->1 and
  // closed on ->0; the symbol's ticker lives as long as any kline interval does.
  readonly klineSubs: Map<string, { sub: KlineSubscription; refCount: number }>;
  readonly tickerSub: MiniTickerSubscription;
}

export const createMarketSubscriptionsManager = (
  opts: MarketSubscriptionsManagerOptions,
): MarketSubscriptionsManager => {
  const handles = new Map<string, SymbolHandle>();
  let stopped = false;

  const consumeKlines = async (
    symbol: string,
    interval: string,
    sub: KlineSubscription,
  ): Promise<void> => {
    try {
      for await (const closed of sub.stream) {
        if (stopped) return;
        await dispatchKline(symbol, interval, closed);
      }
    } catch (err) {
      opts.logger.warn(
        { symbol, interval, err: err },
        'subscriptions-manager: kline consumer loop threw',
      );
    }
  };

  const consumeTickers = async (symbol: string, sub: MiniTickerSubscription): Promise<void> => {
    try {
      for await (const tick of sub.stream) {
        if (stopped) return;
        await dispatchTicker(symbol, tick);
      }
    } catch (err) {
      opts.logger.warn({ symbol, err: err }, 'subscriptions-manager: ticker consumer loop threw');
    }
  };

  const dispatchKline = async (
    symbol: string,
    interval: string,
    closed: ClosedKline,
  ): Promise<void> => {
    try {
      await opts.onMarketEvent({
        kind: 'kline',
        symbol,
        interval,
        openTimeMs: closed.openTimeMs,
        closeTimeMs: closed.closeTimeMs,
        open: closed.open,
        high: closed.high,
        low: closed.low,
        close: closed.close,
        volume: closed.volume,
        isClosed: true,
      });
    } catch (err) {
      opts.logger.warn(
        { symbol, interval, err: err },
        'subscriptions-manager: onMarketEvent(kline) threw',
      );
    }
  };

  const dispatchTicker = async (symbol: string, tick: MiniTicker): Promise<void> => {
    try {
      await opts.onMarketEvent({
        kind: 'mini-ticker',
        symbol,
        closePrice: tick.closePrice,
        eventTimeMs: tick.eventTimeMs,
      });
    } catch (err) {
      opts.logger.warn(
        { symbol, err: err },
        'subscriptions-manager: onMarketEvent(mini-ticker) threw',
      );
    }
  };

  return {
    async start(): Promise<void> {
      // No-op start — the manager is lazy: subscriptions open on the
      // first `addSymbols` call. ProfileManager's market hook drives
      // the symbol set; start exists so the manager fits the existing
      // lifecycle Component contract.
      stopped = false;
    },
    async stop(): Promise<void> {
      stopped = true;
      for (const h of handles.values()) {
        for (const entry of h.klineSubs.values()) entry.sub.unsubscribe();
        h.tickerSub.unsubscribe();
      }
      handles.clear();
    },
    async addSymbols(symbols, candleInterval): Promise<void> {
      for (const symbol of symbols) {
        const intervals = feedIntervals(candleInterval);
        let handle = handles.get(symbol);
        if (!handle) {
          const tickerSub = opts.port.subscribeMiniTicker(symbol);
          handle = { klineSubs: new Map(), tickerSub };
          handles.set(symbol, handle);
          void consumeTickers(symbol, tickerSub);
        }
        for (const iv of intervals) {
          const existing = handle.klineSubs.get(iv);
          if (existing) {
            existing.refCount++;
            continue;
          }
          const sub = opts.port.subscribeKlines(symbol, iv);
          handle.klineSubs.set(iv, { sub, refCount: 1 });
          void consumeKlines(symbol, iv, sub);
        }
      }
    },
    async removeSymbols(symbols, candleInterval): Promise<void> {
      for (const symbol of symbols) {
        const handle = handles.get(symbol);
        if (!handle) continue;
        const intervals = feedIntervals(candleInterval);
        for (const iv of intervals) {
          const entry = handle.klineSubs.get(iv);
          if (!entry) continue;
          if (--entry.refCount <= 0) {
            entry.sub.unsubscribe();
            handle.klineSubs.delete(iv);
            // The interval's kline ring is gone; drop its indicator state too.
            if (opts.clearIndicatorState) {
              try {
                await opts.clearIndicatorState(symbol, iv);
              } catch (err) {
                opts.logger.warn(
                  { symbol, interval: iv, err: err },
                  'subscriptions-manager: clearIndicatorState failed (continuing teardown)',
                );
              }
            }
          }
        }
        if (handle.klineSubs.size === 0) {
          handle.tickerSub.unsubscribe();
          handles.delete(symbol);
        }
      }
    },
    subscribedSymbols(): readonly string[] {
      return [...handles.keys()];
    },
  };
};

/**
 * Re-fires `onResync` for every currently-subscribed symbol. Wire this
 * to `KlineFetcher.onReconnect` so a WS reconnect propagates as a
 * per-symbol resync tick — preserves the original `MarketDataSubscriber`
 * resync behaviour without a separate WS connection.
 */
export const triggerResyncForAllSubscribed = async (
  manager: MarketSubscriptionsManager,
  onResync: (symbol: string) => Promise<void>,
): Promise<void> => {
  await Promise.all(manager.subscribedSymbols().map((s) => onResync(s)));
};
