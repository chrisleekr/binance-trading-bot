// Test adapter for the MarketDataPort.
//
// Provides a deterministic in-memory implementation that tests use instead
// of standing up a real Binance WS connection. Each `(symbol, interval)`
// key has its own bounded ring (newest-first append) plus a fan-out queue
// per active subscription. `pushClosedKline(symbol, interval, candle)`
// drops a candle into both — every active subscriber receives it next
// time their async iterator pulls.
//
// The port contract says subscribers receive klines arriving AFTER they
// subscribe; a fresh subscriber gets only future candles, not the ring
// buffer. Use `loadWindow` for the cold-start seed.

import type { Candle } from '@app/strategy-core';

import { queueAsyncIterable } from './async-queue.js';
import type {
  ClosedKline,
  KlineSubscription,
  KlineWindow,
  MarketDataPort,
  MiniTicker,
  MiniTickerSubscription,
} from './types.js';

interface PendingResolver {
  readonly resolve: (value: IteratorResult<ClosedKline>) => void;
}

interface SubscriptionState {
  /** Closed klines waiting to be yielded to this subscriber. */
  readonly queue: ClosedKline[];
  /** Iterator pull(s) awaiting the next push. Drained FIFO. */
  readonly waiters: PendingResolver[];
  /** Once true, the iterator returns `{ done: true }` and the entry is removed. */
  cancelled: boolean;
}

interface TickerSubscriberState {
  readonly queue: MiniTicker[];
  readonly waiters: { readonly resolve: (v: IteratorResult<MiniTicker>) => void }[];
  cancelled: boolean;
}

interface TickerKeyState {
  readonly subscribers: Set<TickerSubscriberState>;
}

interface SymbolState {
  readonly ring: ClosedKline[];
  readonly subscribers: Set<SubscriptionState>;
}

export interface FakeMarketDataPortOptions {
  /**
   * Max ring length per `(symbol, interval)` key. Older entries are
   * dropped as newer ones land. Default 500 — comfortably above the
   * 250-candle indicator seed window used in production.
   */
  readonly ringSize?: number;
}

const DEFAULT_RING_SIZE = 500;

const keyOf = (symbol: string, interval: string): string => `${symbol}:${interval}`;

/**
 * Ensures the input is structurally a Closed candle. Production producers
 * already mark `isClosed: true`; the test adapter coerces a plain `Candle`
 * to the closed-kline brand on push so test fixtures don't have to repeat
 * the flag.
 */
const asClosedKline = (candle: Candle): ClosedKline => ({ ...candle, isClosed: true });

export interface FakeMarketDataPort extends MarketDataPort {
  /**
   * Append a closed candle to the `(symbol, interval)` stream. Every
   * active subscriber receives it; the ring buffer also retains it for
   * subsequent `loadWindow` calls.
   */
  pushClosedKline(symbol: string, interval: string, candle: Candle): void;
  /**
   * Append a mini-ticker event for a symbol. Every active ticker
   * subscriber for that symbol receives it.
   */
  pushMiniTicker(ticker: MiniTicker): void;
  /**
   * Number of active subscriptions for a `(symbol, interval)` key. Tests
   * use this to verify the ref-counted-unsubscribe contract (production
   * adapters tear down on the last unsubscribe).
   */
  subscriberCount(symbol: string, interval: string): number;
  /** Number of active mini-ticker subscriptions for a symbol. */
  tickerSubscriberCount(symbol: string): number;
  /** Cancel every active subscription and clear all state — for test teardown. */
  reset(): void;
}

export const createFakeMarketDataPort = (
  opts: FakeMarketDataPortOptions = {},
): FakeMarketDataPort => {
  const ringSize = opts.ringSize ?? DEFAULT_RING_SIZE;
  const byKey = new Map<string, SymbolState>();
  const tickersBySymbol = new Map<string, TickerKeyState>();

  const getOrCreate = (symbol: string, interval: string): SymbolState => {
    const k = keyOf(symbol, interval);
    let s = byKey.get(k);
    if (!s) {
      s = { ring: [], subscribers: new Set<SubscriptionState>() };
      byKey.set(k, s);
    }
    return s;
  };

  const port: FakeMarketDataPort = {
    subscribeKlines(symbol, interval): KlineSubscription {
      const state = getOrCreate(symbol, interval);
      const sub: SubscriptionState = { queue: [], waiters: [], cancelled: false };
      state.subscribers.add(sub);

      const stream = queueAsyncIterable<ClosedKline>(sub, () => {
        sub.cancelled = true;
        state.subscribers.delete(sub);
        // Resolve every parked pull with `done: true` so any consumer
        // currently awaiting the next candle drops cleanly.
        while (sub.waiters.length > 0) {
          const w = sub.waiters.shift();
          /* v8 ignore start -- reason: the while guard proves waiters is non-empty, so shift() always returns a value; the falsy-w arm is a noUncheckedIndexedAccess guard only */
          if (w) w.resolve({ done: true, value: undefined });
          /* v8 ignore stop -- reason: end of the unreachable noUncheckedIndexedAccess drain guard above */
        }
      });
      return {
        stream,
        unsubscribe(): void {
          if (sub.cancelled) return;
          sub.cancelled = true;
          state.subscribers.delete(sub);
          while (sub.waiters.length > 0) {
            const w = sub.waiters.shift();
            /* v8 ignore start -- reason: the while guard proves waiters is non-empty, so shift() always returns a value; the falsy-w arm is a noUncheckedIndexedAccess guard only */
            if (w) w.resolve({ done: true, value: undefined });
            /* v8 ignore stop -- reason: end of the unreachable noUncheckedIndexedAccess drain guard above */
          }
        },
      };
    },

    async loadWindow(symbol, interval, size): Promise<KlineWindow> {
      const state = byKey.get(keyOf(symbol, interval));
      if (!state) return [];
      // Newest-at-end: ring is appended forward, so the last `size` entries
      // are the most recent. A test that primes 50 candles and asks for 250
      // gets the full 50 — production adapters would REST-fetch the rest.
      return state.ring.slice(Math.max(0, state.ring.length - size));
    },

    pushClosedKline(symbol, interval, candle): void {
      const state = getOrCreate(symbol, interval);
      const closed = asClosedKline(candle);
      state.ring.push(closed);
      if (state.ring.length > ringSize) state.ring.shift();
      for (const sub of state.subscribers) {
        /* v8 ignore start -- reason: unsubscribe() and return() delete a sub from the set in the same step they set cancelled, so a cancelled sub is never iterated here */
        if (sub.cancelled) continue;
        /* v8 ignore stop -- reason: end of the unreachable cancelled-sub guard above */
        const w = sub.waiters.shift();
        if (w) {
          w.resolve({ done: false, value: closed });
        } else {
          sub.queue.push(closed);
        }
      }
    },

    subscribeMiniTicker(symbol): MiniTickerSubscription {
      let tk = tickersBySymbol.get(symbol);
      if (!tk) {
        tk = { subscribers: new Set<TickerSubscriberState>() };
        tickersBySymbol.set(symbol, tk);
      }
      const sub: TickerSubscriberState = { queue: [], waiters: [], cancelled: false };
      tk.subscribers.add(sub);
      const boundTk = tk;
      const cancel = (): void => {
        if (sub.cancelled) return;
        sub.cancelled = true;
        boundTk.subscribers.delete(sub);
        while (sub.waiters.length > 0) {
          const w = sub.waiters.shift();
          /* v8 ignore start -- reason: the while guard proves waiters is non-empty, so shift() always returns a value; the falsy-w arm is a noUncheckedIndexedAccess guard only */
          if (w) w.resolve({ done: true, value: undefined });
          /* v8 ignore stop -- reason: end of the unreachable noUncheckedIndexedAccess drain guard above */
        }
      };
      const stream = queueAsyncIterable<MiniTicker>(sub, cancel);
      return { stream, unsubscribe: cancel };
    },

    pushMiniTicker(ticker): void {
      const tk = tickersBySymbol.get(ticker.symbol);
      if (!tk) return;
      for (const sub of tk.subscribers) {
        /* v8 ignore start -- reason: cancel() deletes a ticker sub from the set in the same step it sets cancelled, so a cancelled sub is never iterated here */
        if (sub.cancelled) continue;
        /* v8 ignore stop -- reason: end of the unreachable cancelled-ticker-sub guard above */
        const w = sub.waiters.shift();
        if (w) {
          w.resolve({ done: false, value: ticker });
        } else {
          sub.queue.push(ticker);
        }
      }
    },

    subscriberCount(symbol, interval): number {
      return byKey.get(keyOf(symbol, interval))?.subscribers.size ?? 0;
    },

    tickerSubscriberCount(symbol): number {
      return tickersBySymbol.get(symbol)?.subscribers.size ?? 0;
    },

    reset(): void {
      for (const state of byKey.values()) {
        for (const sub of state.subscribers) {
          sub.cancelled = true;
          while (sub.waiters.length > 0) {
            const w = sub.waiters.shift();
            /* v8 ignore start -- reason: the while guard proves waiters is non-empty, so shift() always returns a value; the falsy-w arm is a noUncheckedIndexedAccess guard only */
            if (w) w.resolve({ done: true, value: undefined });
            /* v8 ignore stop -- reason: end of the unreachable noUncheckedIndexedAccess drain guard above */
          }
        }
      }
      byKey.clear();
      for (const tk of tickersBySymbol.values()) {
        for (const sub of tk.subscribers) {
          sub.cancelled = true;
          while (sub.waiters.length > 0) {
            const w = sub.waiters.shift();
            /* v8 ignore start -- reason: the while guard proves waiters is non-empty, so shift() always returns a value; the falsy-w arm is a noUncheckedIndexedAccess guard only */
            if (w) w.resolve({ done: true, value: undefined });
            /* v8 ignore stop -- reason: end of the unreachable noUncheckedIndexedAccess drain guard above */
          }
        }
      }
      tickersBySymbol.clear();
    },
  };

  return port;
};
