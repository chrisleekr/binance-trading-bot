// Production `MarketDataPort` adapter.
//
// One process-wide instance multiplexes every consumer over a single
// Binance combined-stream WebSocket and a single in-memory ring buffer
// per `(symbol, interval)`. The technicals cron, the IndicatorComputer
// cold-seed, and the tick path all share the same window — five profiles
// trading BTCUSDT@1h create one REST cold-load and one WS stream, not
// five.
//
// Lifecycle invariants:
//   - First subscriber for a `(symbol, interval)` key triggers a Binance
//     JSON-RPC `SUBSCRIBE` on the shared connection (or opens the
//     connection if it's the first key overall). On open, a REST
//     `getKlines` cold-loads the ring so `loadWindow` answers
//     immediately.
//   - Last unsubscribe for a key sends `UNSUBSCRIBE` and drops the ring.
//     The WS connection stays open if other keys are subscribed; it
//     closes when no key remains.
//   - Reconnect is exponential-backoff (factor 2, cap 60s); on reconnect
//     every still-subscribed stream is re-`SUBSCRIBE`d.
//
// Only CLOSED candles (`x: true` in the Binance frame) reach subscribers
// and the ring — strategies and indicators must never fold a still-
// forming bar.

import { BINANCE_MAX_KLINE_LIMIT } from '../public-klines.js';
import { queueAsyncIterable } from './async-queue.js';
import type { BinanceWs, BinanceWsFactory } from './ws.js';

/**
 * Narrow logger shape — adapter logs are advisory (REST cold-load failed,
 * invalid frame, reconnect scheduled). Defining a structural interface
 * here lets the @app/binance package stay without a pino dependency; the
 * worker passes a real pino logger, tests pass a no-op.
 */
interface AdapterLogger {
  info(payload: Record<string, unknown>, msg: string): void;
  warn(payload: Record<string, unknown>, msg: string): void;
}
import type {
  ClosedKline,
  KlineSubscription,
  KlineWindow,
  MarketDataPort,
  MiniTicker,
  MiniTickerSubscription,
} from './types.js';
import type { WeightGovernor } from '../rate-limit/weight-governor.js';

const BINANCE_MAX_STREAMS_PER_CONNECTION = 1024;
// Hard ceiling on pool members. 16 × 1024 = 16384 streams ≈ 4096 symbols at the
// 4 streams/symbol the worker subscribes (trading interval + 1m + 1d + miniTicker).
// Exceeding it throws loudly rather than silently dropping a subscription — a
// symbol set this large needs the deferred consistent-hash sharding, not a wider
// single-process fan-out.
const BINANCE_MAX_POOL_MEMBERS = 16;
// Sized for the common case, not the worst one: the ring is per (symbol, interval) heap that multiplies across the whole symbol set, so it holds the window a typical config asks for rather than the ceiling one could ask for. `requiredWindow` is config-driven, so a lookback beyond the ring is legitimate and stays served by `loadWindow`'s REST fallback, memoised per candle.
const DEFAULT_RING_SIZE = 256;
const DEFAULT_BACKOFF = { initialMs: 1_000, maxMs: 60_000, factor: 2 } as const;
/** Flat Binance spot weight for `GET /api/v3/klines` (2 at any limit up to {@link BINANCE_MAX_KLINE_LIMIT}). */
const KLINE_WEIGHT = 2;

/**
 * REST `limit` that yields `closedNeeded` CLOSED candles. `fetchClosedKlines` drops the still-forming bar, so a request for N rows comes back with N-1 closed ones and a caller gating on `candles.length >= closedNeeded` would never pass. Binance documents `limit` as an integer in [1, {@link BINANCE_MAX_KLINE_LIMIT}] and the value is interpolated straight into the query string, so this is the single normalisation point as well as the single clamp point: a fractional input would ride out as `&limit=250.5` and Binance would reject every request, failing that (profile, symbol) on every tick, exits included. A non-finite input needs its own arm because the arithmetic cannot clamp it: `Math.ceil(NaN) + 1` is NaN and both `Math.max` and `Math.min` propagate it, so it would ride out as `&limit=NaN` and Binance would reject the request with no clue as to which value was malformed. Collapsing it to the smallest legal limit keeps the request well-formed, but only the caller can make that collapse visible: it must normalise the size the same way and read both its slice bound and its short-window verdict off the normalised value, because a raw NaN silently defeats both (`slice(NaN)` coerces to 0 and returns everything, and `length < NaN` is false), turning a collapsed request into an empty window that is memoised without a single log line.
 *
 * @param closedNeeded - Count of closed candles the caller must end up holding. Originates in operator config, which the live worker may hand to a strategy unparsed, so it is not guaranteed to be a positive integer, nor even a number at all.
 * @returns The `limit` to send: an integer in [1, {@link BINANCE_MAX_KLINE_LIMIT}].
 */
const restLimitFor = (closedNeeded: number): number => {
  if (!Number.isFinite(closedNeeded)) return 1;
  return Math.min(Math.max(Math.ceil(closedNeeded) + 1, 1), BINANCE_MAX_KLINE_LIMIT);
};

interface BackoffConfig {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor: number;
}

interface PendingResolver {
  readonly resolve: (value: IteratorResult<ClosedKline>) => void;
}

interface SubscriberState {
  readonly queue: ClosedKline[];
  readonly waiters: PendingResolver[];
  cancelled: boolean;
}

/** Which branch of `loadWindow` produced a memoised answer. A ring answer is a synchronous slice of an in-memory array, so recomputing it is free; a REST answer cost a weight-2 network round trip. The eviction policy needs to tell them apart so it can prefer spending a cheap entry over an expensive one. It is a preference, not a guarantee: once every entry under the cap is REST-sourced there is nothing cheap left to spend, and the oldest expensive one goes even for a ring-sourced insert. That degrades only past four distinct sizes on one key, which is beyond the handful the profiles sharing a (symbol, interval) plus the indicator computer actually ask for. */
type WindowSource = 'ring' | 'rest';

interface MemoEntry {
  readonly window: readonly ClosedKline[];
  /** Wall-clock ms at which this answer was installed, from the injected clock. Read only by the age backstop. */
  readonly installedAtMs: number;
  readonly source: WindowSource;
}

interface KeyState {
  readonly symbol: string;
  readonly interval: string;
  readonly stream: string; // e.g. "btcusdt@kline_1h"
  readonly ring: ClosedKline[];
  readonly subscribers: Set<SubscriberState>;
  /** True while the REST cold-load for this key is in flight. */
  coldLoading: boolean;
  /**
   * Memoised `loadWindow` answers for this key, keyed by requested window size and sourced either from a ring slice or from the REST fallback that serves a size the ring cannot cover. `loadWindow` runs every tick (~1/s/symbol on the mini-ticker path), so without the memo the ring path re-copies up to `size` candles per tick and the REST path re-issues a weight-2 request per tick, forever. Holding the REST answer here is what collapses that to one request per candle. Keyed by size rather than holding one slot because the key is `(symbol, interval)` while the size is per profile: two profiles on one symbol with different lookbacks, plus the indicator computer's fixed 200, hit the same key with different sizes, and a single slot would have them evict each other every tick — putting the above-ring one straight back on a REST fetch per tick. Freshness takes three mechanisms, not one: every ring mutation clears the whole map, which is sufficient for the ring branch because that branch computes and installs its answer synchronously; the REST branch additionally re-checks {@link KeyState.ringGeneration} because its answer is computed across an await; and every entry carries an install timestamp so it expires on its own once no invalidating event can reach it at all. Windows are typed `readonly` and consumers (indicators, strategy) only iterate them.
   */
  readonly windowCache: Map<number, MemoEntry>;
  /**
   * Bumped on every ring mutation, beside the `windowCache` clear. Exists because clearing alone cannot be observed by a writer that resolves later: an in-flight REST window captured before a candle closed would re-install itself over the cleared map and then go unrefreshed until the following close, serving a one-candle-stale window for a whole candle period. Re-reading the map cannot stand in for this — an entry for a DIFFERENT size leaves the map non-empty, and an entry for this size may have been installed by a later caller, so "cleared while I was fetching" and "never set" are indistinguishable.
   */
  ringGeneration: number;
  /** Stable id of the pool member that owns this key's stream (O(1) routing). */
  memberId: number;
}

interface TickerSubscriberState {
  readonly queue: MiniTicker[];
  readonly waiters: { readonly resolve: (v: IteratorResult<MiniTicker>) => void }[];
  cancelled: boolean;
}

interface TickerKeyState {
  readonly symbol: string;
  readonly stream: string; // e.g. "btcusdt@miniTicker"
  readonly subscribers: Set<TickerSubscriberState>;
  /** Stable id of the pool member that owns this key's stream (O(1) routing). */
  memberId: number;
}

/**
 * One WS connection in the pool. A single combined-stream socket caps at 1024
 * streams (Binance), so a large symbol set is sharded across N members. Each
 * member owns its socket, its in-flight RPC buffers, its backoff cursor, and the
 * set of streams it currently carries; reconnect/resubscribe/liveness are all
 * per-member so a stall on one member never resubscribes another's streams.
 */
interface Connection {
  readonly id: number;
  ws: BinanceWs | null;
  // `ws` is set the moment `connect()` constructs the socket, but the underlying
  // WebSocket is CONNECTING until `onOpen` fires; `send` while CONNECTING throws
  // (ws@8: readyState 0). Track open separately so subscribes during the connect
  // window buffer their RPCs and flush on OPEN.
  isOpen: boolean;
  // Timestamp of the last received frame on THIS member (any channel). Seeded at
  // each open and bumped on every frame; the aggregate `msSinceLastFrame()` takes
  // the worst case across members.
  lastFrameMs: number;
  readonly pendingSubscribes: Set<string>;
  readonly pendingUnsubscribes: Set<string>;
  nextRpcId: number;
  reconnectMs: number;
  // onReconnect fires once per member after its FIRST open: a fresh member's
  // first open is a cold start, subsequent opens are reconnects.
  hasConnectedOnce: boolean;
  readonly streams: Set<string>;
}

export interface KlineFetcherOptions {
  /** Combined-stream base URL (e.g. `wss://stream.binance.com:9443/stream`). */
  readonly wsUrl: string;
  readonly wsFactory: BinanceWsFactory;
  /**
   * REST fallback for `loadWindow` when the ring is shorter than the
   * requested size. Always returns oldest-first; the adapter normalises
   * to the `ClosedKline` shape.
   */
  readonly fetchRestKlines: (
    symbol: string,
    interval: string,
    limit: number,
  ) => Promise<readonly ClosedKline[]>;
  /**
   * Per-IP weight governor. The REST cold-load reserves its weight here
   * so cron + tick path share the same per-IP budget. Optional — when
   * absent the REST call goes through unrestricted (useful for tests).
   */
  readonly weightGovernor?: WeightGovernor;
  readonly logger: AdapterLogger;
  /** Rows held per (symbol, interval); defaults to `DEFAULT_RING_SIZE` (256). A `loadWindow` above it is answered by REST rather than by growing the ring. */
  readonly ringSize?: number;
  readonly backoff?: BackoffConfig;
  /** Injected for tests so reconnect schedules don't depend on real timers. */
  readonly schedule?: (fn: () => void, delayMs: number) => void;
  /**
   * Clock for frame-liveness tracking and for stamping/expiring memoised `loadWindow` answers. Defaults to `Date.now`, which is wall clock and NOT monotonic: a step backwards (NTP correction, container resync) makes both elapsed reads negative, which the liveness watchdog reads as a fresh frame and the memo age check treats as expired so it fails toward a refetch rather than toward serving a frozen window. Injected so both are testable without real time. Date is allowed here (this is the I/O boundary, not a pure strategy package).
   */
  readonly now?: () => number;
  /**
   * Fired every time the WS connection (re)opens. Subscribers that need to
   * trigger a state-resync per active key (e.g. enqueue a `resync` tick so
   * the strategy recomputes from authoritative state after a WS blip) hook
   * this. Not fired on the very first open of a fresh fetcher — only on
   * reconnects after a close — so a normal cold start does not also
   * trigger every consumer's resync codepath.
   */
  readonly onReconnect?: () => void;
}

export interface KlineFetcher extends MarketDataPort {
  /**
   * Late-bind the reconnect handler after construction. Lets the boot
   * wire build the fetcher as a leaf (no forward ref to the
   * subscriptions manager it must resync) and inject the back-edge once
   * the manager exists. Overwrites any handler passed at construction.
   */
  setOnReconnect(handler: () => void): void;
  /** Active subscriptions for one key — exposed for tests + ops introspection. */
  subscriberCount(symbol: string, interval: string): number;
  /** Distinct (symbol, interval) keys with at least one subscriber. */
  activeKeyCount(): number;
  /**
   * Aggregate connection liveness across the pool. True iff EVERY non-empty
   * member is open (all-open): a partially-stalled feed (one member down while
   * others serve) reads as not-whole so the liveness watchdog recovers it rather
   * than treating the feed as healthy. False when the pool is empty.
   */
  isConnected(): boolean;
  /**
   * Worst-case milliseconds since the last WS frame on ANY pool member (max over
   * members of `now - member.lastFrameMs`). A silently-dead member (TCP up,
   * Binance stopped delivering) keeps `isConnected()` true on the all-open read
   * only until its peers stall too; taking the worst case means a single stalled
   * member is enough to trip the watchdog's stale-feed threshold. Empty pool
   * reports the time since the fetcher was constructed (bounded, not Infinity).
   */
  msSinceLastFrame(): number;
  /**
   * Force-reconnect EVERY pool member so the normal `onClose` reconnect +
   * per-member resubscribe path rebuilds the whole feed. Used by the liveness
   * watchdog to recover a silently-stalled feed. Per member it is a no-op when
   * that member is not open; flips the aggregate `isConnected()` to false
   * synchronously so a caller can fall through to its gap-fill path in the same
   * pass.
   */
  forceReconnect(): void;
  /** Tear down every subscription, close the WS, drop every ring. */
  shutdown(): Promise<void>;
}

const streamOf = (symbol: string, interval: string): string =>
  `${symbol.toLowerCase()}@kline_${interval}`;

const tickerStreamOf = (symbol: string): string => `${symbol.toLowerCase()}@miniTicker`;

const keyOf = (symbol: string, interval: string): string => `${symbol}|${interval}`;

// Ceiling on distinct memoised window sizes per key. The real population is the set of window sizes the profiles sharing this (symbol, interval) ask for plus the indicator computer's fixed one, which is a handful; the cap only exists so a caller outside that shape cannot grow the map once per call. It also bounds the memo's heap against the same (symbols × intervals) multiplier the DEFAULT_RING_SIZE rationale above weighs, and the two bounds are not the same size: a 'ring' entry is a slice of the ring, so it copies references and duplicates no kline objects, while a 'rest' entry OWNS every object it returned. Worst case per key is therefore four REST entries at MAX_CANDLE_WINDOW, 3,996 owned klines ≈ 1.4-1.8 MB, against the ring's ~100 KB — roughly 15×. The realistic case is one above-ring size per key, ≈160 KB.
const MAX_WINDOW_CACHE_ENTRIES = 4;
// Backstop expiry for a memoised window, needed because every other invalidator is socket-driven and there are two shapes of outage where no such event can ever arrive: a dead socket (onClose fires once, and the very next loadWindow re-installs an entry that nothing will clear for the rest of the outage) and a single stream that goes silent while its pool member stays open serving its other streams (no fanOut, no onClose, and `msSinceLastFrame` is per-member so the watchdog cannot see it either). Both leave ticks running on live mini-ticker prices against a frozen window. 60s is one 1m candle, the shortest interval the worker subscribes, so on a healthy 1m key the natural fanOut almost always invalidates first and this bound adds no fetches there.
const MEMO_MAX_AGE_MS = 60_000;

/**
 * Make room for one more entry when the memo map is at its ceiling, sacrificing the cheapest answer available. A ring answer is a synchronous slice of an in-memory array and costs nothing to recompute, while a REST answer costs a weight-2 network round trip, so the cheap entries are spent first and the expensive one survives. Recency policies do not work here: the access pattern is a fixed set of sizes cycling once per tick, under which FIFO and LRU both evict the REST entry as reliably as a wholesale clear did, putting the above-ring window straight back on a request per tick.
 *
 * @param cache - Memo map at its ceiling; exactly one entry is removed from it.
 */
const evictForInsert = (cache: Map<number, MemoEntry>): void => {
  // Map iterates in insertion order, so the first ring-sourced entry is the oldest cheap one.
  for (const [key, entry] of cache) {
    if (entry.source === 'ring') {
      cache.delete(key);
      return;
    }
  }
  // Nothing cheap to sacrifice — every entry cost a request, so the oldest goes.
  for (const key of cache.keys()) {
    cache.delete(key);
    return;
  }
};

/**
 * Install a memoised window, evicting one entry first when the map is at its ceiling.
 *
 * @param state - Key whose memo map receives the window.
 * @param size - Requested window size this answer belongs to; also the map key.
 * @param window - Candles to serve for that size until the ring next moves or the entry ages out.
 * @param installedAtMs - Wall-clock ms this answer was computed at, from the fetcher's injected clock; the age backstop measures from it.
 * @param source - Which branch produced the window, which is what decides whether it is cheap enough to evict.
 */
const rememberWindow = (
  state: KeyState,
  size: number,
  window: readonly ClosedKline[],
  installedAtMs: number,
  source: WindowSource,
): void => {
  if (state.windowCache.size >= MAX_WINDOW_CACHE_ENTRIES) evictForInsert(state.windowCache);
  state.windowCache.set(size, { window, installedAtMs, source });
};

interface KlineFrameInner {
  readonly t?: number;
  readonly T?: number;
  readonly o?: string;
  readonly h?: string;
  readonly l?: string;
  readonly c?: string;
  readonly v?: string;
  readonly x?: boolean;
}

interface ParsedClosed {
  readonly symbol: string;
  readonly interval: string;
  readonly kline: ClosedKline;
}

interface ParsedMiniTicker {
  readonly kind: 'mini-ticker';
  readonly value: MiniTicker;
}

const parseMiniTickerFromFrame = (stream: string, data: unknown): ParsedMiniTicker | null => {
  if (typeof data !== 'object' || data === null) return null;
  const at = stream.indexOf('@');
  if (at < 0) return null;
  const channel = stream.slice(at + 1);
  if (channel !== 'miniTicker') return null;
  const symbol = stream.slice(0, at).toUpperCase();
  const e = data as { E?: unknown; c?: unknown };
  if (typeof e.E !== 'number' || typeof e.c !== 'string') return null;
  return {
    kind: 'mini-ticker',
    value: { symbol, closePrice: e.c, eventTimeMs: e.E },
  };
};

const parseClosedFromFrame = (stream: string, data: unknown): ParsedClosed | null => {
  if (typeof data !== 'object' || data === null) return null;
  const at = stream.indexOf('@');
  if (at < 0) return null;
  const symbol = stream.slice(0, at).toUpperCase();
  const channel = stream.slice(at + 1);
  if (!channel.startsWith('kline_')) return null;
  const interval = channel.slice('kline_'.length);
  const k = (data as { k?: KlineFrameInner }).k;
  if (
    !k ||
    typeof k.t !== 'number' ||
    typeof k.T !== 'number' ||
    typeof k.o !== 'string' ||
    typeof k.h !== 'string' ||
    typeof k.l !== 'string' ||
    typeof k.c !== 'string' ||
    typeof k.v !== 'string' ||
    typeof k.x !== 'boolean'
  ) {
    return null;
  }
  if (!k.x) return null;
  return {
    symbol,
    interval,
    kline: {
      openTimeMs: k.t,
      closeTimeMs: k.T,
      open: k.o,
      high: k.h,
      low: k.l,
      close: k.c,
      volume: k.v,
      isClosed: true,
    } satisfies ClosedKline,
  };
};

export const createKlineFetcher = (opts: KlineFetcherOptions): KlineFetcher => {
  const ringSize = opts.ringSize ?? DEFAULT_RING_SIZE;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const now = opts.now ?? Date.now;
  // Mutable so `setOnReconnect` can late-bind the back-edge after
  // construction; seeded from the optional constructor arg for callers
  // (and tests) that wire it up front.
  let onReconnect = opts.onReconnect;
  const schedule =
    opts.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      // Don't block process exit waiting for a reconnect timer.
      (t as { unref?: () => void }).unref?.();
    });

  const byKey = new Map<string, KeyState>();
  const tickersBySymbol = new Map<string, TickerKeyState>();
  // Seeded now so a pre-connect `msSinceLastFrame()` read is bounded, not
  // Infinity, before any member exists.
  const constructedAtMs = now();
  // The connection pool. One member until the symbol set crosses 1024 streams,
  // then sharded. Members are addressed by stable `id` (not array index) so
  // pruning an empty member never reroutes another member's keys.
  const members: Connection[] = [];
  let nextMemberId = 0;
  let stopped = false;

  const memberById = (id: number): Connection | undefined => members.find((m) => m.id === id);

  const allocMember = (): Connection => {
    if (members.length >= BINANCE_MAX_POOL_MEMBERS) {
      throw new Error(
        `KlineFetcher: pool exceeds ${BINANCE_MAX_POOL_MEMBERS} members (${BINANCE_MAX_POOL_MEMBERS * BINANCE_MAX_STREAMS_PER_CONNECTION} streams); a symbol set this large needs sharding`,
      );
    }
    const m: Connection = {
      id: nextMemberId++,
      ws: null,
      isOpen: false,
      lastFrameMs: now(),
      pendingSubscribes: new Set<string>(),
      pendingUnsubscribes: new Set<string>(),
      nextRpcId: 1,
      reconnectMs: backoff.initialMs,
      hasConnectedOnce: false,
      streams: new Set<string>(),
    };
    members.push(m);
    return m;
  };

  // Greedy assignment: pick the first member with spare capacity, else allocate a
  // new one. The 1024 cap is enforced here (before any send), so a member's
  // stream set can never exceed the cap; `ensureLimit` in `connect` is
  // defense-in-depth against a logic regression. Records the stream on the chosen
  // member and returns it.
  const assignStream = (stream: string): Connection => {
    const owner =
      members.find((m) => m.streams.size < BINANCE_MAX_STREAMS_PER_CONNECTION) ?? allocMember();
    ensureLimit(owner.streams.size + 1);
    owner.streams.add(stream);
    return owner;
  };

  const activeStreams = (m: Connection): string[] => [...m.streams];

  const sendRpc = (
    m: Connection,
    method: 'SUBSCRIBE' | 'UNSUBSCRIBE',
    streams: readonly string[],
  ): void => {
    /* v8 ignore start -- reason: every sendRpc call passes a single-element [stream] array, so the empty-streams guard is never true */
    if (streams.length === 0) return;
    /* v8 ignore stop -- reason: end of the unreachable empty-streams guard above */
    if (!m.ws || !m.isOpen) {
      // Socket not ready yet. Queue the streams; opposing pending
      // entries cancel out so a fast subscribe→unsubscribe within the
      // CONNECTING window does not leak an RPC after open.
      const add = method === 'SUBSCRIBE' ? m.pendingSubscribes : m.pendingUnsubscribes;
      const drop = method === 'SUBSCRIBE' ? m.pendingUnsubscribes : m.pendingSubscribes;
      for (const s of streams) {
        if (drop.has(s)) drop.delete(s);
        else add.add(s);
      }
      return;
    }
    m.ws.send(JSON.stringify({ method, params: streams, id: m.nextRpcId++ }));
  };

  const flushPendingRpcs = (m: Connection): void => {
    /* v8 ignore start -- reason: flushPendingRpcs runs only inside onOpen, which sets ws and isOpen first, so this not-ready guard is never true */
    if (!m.ws || !m.isOpen) return;
    /* v8 ignore stop -- reason: end of the unreachable not-ready guard above */
    if (m.pendingSubscribes.size > 0) {
      const params = [...m.pendingSubscribes];
      m.pendingSubscribes.clear();
      m.ws.send(JSON.stringify({ method: 'SUBSCRIBE', params, id: m.nextRpcId++ }));
    }
    if (m.pendingUnsubscribes.size > 0) {
      const params = [...m.pendingUnsubscribes];
      m.pendingUnsubscribes.clear();
      m.ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params, id: m.nextRpcId++ }));
    }
  };

  // Per-connection cap guard. `assignStream` already caps every member at 1024
  // streams before any send, and `connect` only ever builds a URL from one
  // member's own (≤1024) stream set — so this throw is defense-in-depth against a
  // future routing regression, not a reachable path under correct assignment.
  const ensureLimit = (count: number): void => {
    /* v8 ignore start -- reason: assignStream caps each member at BINANCE_MAX_STREAMS_PER_CONNECTION before recording a stream, so connect/assignStream never pass a count over the cap; this is an unreachable defense-in-depth guard */
    if (count > BINANCE_MAX_STREAMS_PER_CONNECTION) {
      throw new Error(
        `KlineFetcher: ${count} streams exceeds Binance combined-stream cap of ${BINANCE_MAX_STREAMS_PER_CONNECTION}`,
      );
    }
    /* v8 ignore stop -- reason: end of the unreachable per-connection cap guard above */
  };

  const fanOut = (state: KeyState, kline: ClosedKline): void => {
    state.ring.push(kline);
    if (state.ring.length > ringSize) state.ring.shift();
    // The ring changed; drop every memoised window so the next loadWindow recomputes, and bump the generation so a REST window already in flight cannot install itself over that drop.
    state.windowCache.clear();
    state.ringGeneration += 1;
    for (const sub of state.subscribers) {
      /* v8 ignore start -- reason: cancelSubscriber deletes a sub from the set in the same step it sets cancelled, so a cancelled sub is never iterated here */
      if (sub.cancelled) continue;
      /* v8 ignore stop -- reason: end of the unreachable cancelled-sub guard above */
      const w = sub.waiters.shift();
      if (w) {
        w.resolve({ done: false, value: kline });
      } else {
        sub.queue.push(kline);
      }
    }
  };

  const handleFrame = (m: Connection, raw: string): void => {
    // Any inbound frame — kline, miniTicker, or an RPC ack — proves the socket
    // is still delivering data, so bump the liveness clock before routing (even
    // a malformed frame counts: it arrived). A delivered frame is also the only
    // proof the connection is healthy, so reset the reconnect backoff here (not
    // on open) — an open-but-silent socket then keeps backing off across forced
    // reconnects instead of looping at the initial delay. Per member: a frame on
    // one member never resets a stalled peer's backoff.
    m.lastFrameMs = now();
    m.reconnectMs = backoff.initialMs;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      opts.logger.warn({ err: err }, 'kline-fetcher WS: invalid JSON');
      return;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('stream' in parsed) ||
      !('data' in parsed)
    ) {
      // SUBSCRIBE / UNSUBSCRIBE ACK arrives without `stream` envelope — ignore.
      return;
    }
    const stream = (parsed as { stream: string }).stream;
    const dataRaw = (parsed as { data: unknown }).data;
    // Route on channel — kline frames fan into the kline rings, miniTicker
    // frames fan into the ticker subscriber queues. The same WS multiplexes
    // both, so a single combined-stream connection serves every consumer.
    const klineEv = parseClosedFromFrame(stream, dataRaw);
    if (klineEv) {
      const state = byKey.get(keyOf(klineEv.symbol, klineEv.interval));
      if (state) fanOut(state, klineEv.kline);
      return;
    }
    const tickerEv = parseMiniTickerFromFrame(stream, dataRaw);
    if (tickerEv) {
      const tk = tickersBySymbol.get(tickerEv.value.symbol);
      if (!tk) return;
      for (const sub of tk.subscribers) {
        /* v8 ignore start -- reason: cancel() deletes a ticker sub from the set in the same step it sets cancelled, so a cancelled sub is never iterated here */
        if (sub.cancelled) continue;
        /* v8 ignore stop -- reason: end of the unreachable cancelled-ticker-sub guard above */
        const w = sub.waiters.shift();
        if (w) {
          w.resolve({ done: false, value: tickerEv.value });
        } else {
          sub.queue.push(tickerEv.value);
        }
      }
    }
  };

  const coldLoad = async (state: KeyState): Promise<void> => {
    /* v8 ignore start -- reason: coldLoad runs once per key (only when isNewKey), so the in-flight reentrancy guard is never true */
    if (state.coldLoading) return;
    /* v8 ignore stop -- reason: end of the unreachable coldLoad reentrancy guard above */
    state.coldLoading = true;
    try {
      if (opts.weightGovernor) await opts.weightGovernor.reserve(KLINE_WEIGHT);
      const rows = await opts.fetchRestKlines(state.symbol, state.interval, restLimitFor(ringSize));
      // Prepend any historical candles we don't already hold. Production
      // WS may have landed a candle by now; preserve those in the ring.
      const have = new Set(state.ring.map((k) => k.openTimeMs));
      const merged = [...rows.filter((r) => !have.has(r.openTimeMs)), ...state.ring];
      merged.sort((a, b) => a.openTimeMs - b.openTimeMs);
      // Cap to ringSize.
      while (merged.length > ringSize) merged.shift();
      state.ring.length = 0;
      state.ring.push(...merged);
      // Ring rebuilt; invalidate every memoised window and bump the generation for any REST window in flight.
      state.windowCache.clear();
      state.ringGeneration += 1;
    } catch (err) {
      opts.logger.warn(
        { symbol: state.symbol, interval: state.interval, err: err },
        'kline-fetcher: REST cold-load failed; ring stays as-is',
      );
    } finally {
      state.coldLoading = false;
    }
  };

  const connect = (m: Connection): void => {
    /* v8 ignore start -- reason: connect runs on first subscribe (stopped is false) or via a reconnect schedule that onClose only arms when !stopped, so the stopped guard is never true here; and connect always runs with at least one active stream on the member (the subscribe that triggered it, or onClose only reconnecting when the member still holds streams) */
    if (stopped) return;
    const streams = activeStreams(m);
    if (streams.length === 0) return;
    /* v8 ignore stop -- reason: end of the unreachable stopped / empty-streams guards above */
    // Idempotent: a member with a live or CONNECTING socket must never be
    // re-connected. During a reconnect-backoff window the member sits at ws===null
    // with a scheduled connect pending; if a new key with spare capacity routes to
    // it first, the subscribe path calls connect immediately and builds the socket.
    // Without this guard the later scheduled connect would build a second socket
    // and orphan the first (leaked connection + duplicate frames). onClose nulls
    // m.ws before scheduling, so legitimate reconnection still proceeds.
    if (m.ws) return;
    ensureLimit(streams.length);
    const url = `${opts.wsUrl}?streams=${encodeURIComponent(streams.join('/'))}`;
    const conn = opts.wsFactory(url);
    m.ws = conn;
    conn.onOpen(() => {
      m.isOpen = true;
      // A fresh socket has delivered no frames yet; reset the liveness clock so
      // the watchdog does not read the just-opened connection as stale. Backoff
      // is NOT reset here — only a real frame proves the connection healthy (see
      // handleFrame). Resetting on open alone would let an open-but-silent
      // upstream (the stall this watchdog force-reconnects) loop at the initial
      // delay forever instead of backing off.
      m.lastFrameMs = now();
      opts.logger.info(
        { memberId: m.id, streamCount: streams.length },
        'kline-fetcher WS connected',
      );
      // Streams added during the CONNECTING window were buffered by
      // sendRpc; deliver them now that the socket can accept frames.
      flushPendingRpcs(m);
      // Fire onReconnect only after the FIRST open of THIS member. A fresh
      // member's first open isn't a reconnect — it's a cold start (the initial
      // pool member at boot, or a freshly-allocated shard) — and consumers would
      // otherwise eat a redundant resync. Subsequent opens (after a close) ARE
      // reconnects. Tracked per member so adding a shard never fires a spurious
      // whole-feed resync, and a single member's reconnect fires exactly one.
      if (m.hasConnectedOnce) {
        try {
          onReconnect?.();
        } catch (err) {
          opts.logger.warn(
            { memberId: m.id, err: err },
            'kline-fetcher: onReconnect handler threw',
          );
        }
      }
      m.hasConnectedOnce = true;
    });
    conn.onMessage((raw) => handleFrame(m, raw));
    conn.onError((err) => {
      opts.logger.warn({ memberId: m.id, err: err }, 'kline-fetcher WS error');
    });
    conn.onClose(() => {
      m.ws = null;
      m.isOpen = false;
      // Nothing invalidates a memo while this member is down: no fanOut can arrive and the ring stops advancing, so a window held across the outage would pin every consumer to pre-outage candles for its whole duration — against a live price, since the liveness watchdog keeps ticks running off the mini-ticker. Dropping them puts an above-ring size back on the REST path, which is what served it before the memo existed and is independent of this socket. Scoped to this member's own keys so a sibling shard's close does not evict a healthy shard's memos.
      for (const state of byKey.values()) {
        if (state.memberId !== m.id) continue;
        state.windowCache.clear();
        state.ringGeneration += 1;
      }
      // Pending RPCs are obsolete after disconnect: the next `connect(m)`
      // rebuilds the URL from this member's `activeStreams`, covering every
      // still-subscribed stream it owns. Clear the buffer so a reconnect doesn't
      // fire redundant SUBSCRIBE rpcs after open.
      m.pendingSubscribes.clear();
      m.pendingUnsubscribes.clear();
      if (stopped) return;
      // The member lost all its streams (last unsubscribe dropped them and the
      // member was pruned, or it carries nothing) → don't reconnect it.
      if (m.streams.size === 0) return;
      const delay = m.reconnectMs;
      m.reconnectMs = Math.min(m.reconnectMs * backoff.factor, backoff.maxMs);
      opts.logger.warn(
        { memberId: m.id, delayMs: delay },
        'kline-fetcher WS closed; scheduling reconnect',
      );
      schedule(() => connect(m), delay);
    });
  };

  // Drop a stream from its owning member: UNSUBSCRIBE on that member, and when
  // the member then carries nothing, close its socket and prune it from the
  // pool. The member is addressed by stable id, so pruning never reroutes a
  // sibling member's keys.
  const releaseStream = (memberId: number, stream: string): void => {
    const m = memberById(memberId);
    /* v8 ignore start -- reason: a key/ticker always records the id of a live member once assigned, so the lookup never misses; defense-in-depth against both a noUncheckedIndexedAccess miss and the memberId === -1 sentinel window (a key's memberId is -1 until the isNewKey path assigns it, so a release before assignment would also land here) */
    if (!m) return;
    /* v8 ignore stop -- reason: end of the unreachable missing-member guard above */
    m.streams.delete(stream);
    sendRpc(m, 'UNSUBSCRIBE', [stream]);
    if (m.streams.size === 0) {
      if (m.ws) {
        m.ws.close();
        m.ws = null;
      }
      const idx = members.indexOf(m);
      /* v8 ignore start -- reason: m came from members.find, so it is always present; the index guard is defense-in-depth */
      if (idx >= 0) members.splice(idx, 1);
      /* v8 ignore stop -- reason: end of the unreachable index guard above */
    }
  };

  const cancelSubscriber = (state: KeyState, sub: SubscriberState): void => {
    if (sub.cancelled) return;
    sub.cancelled = true;
    state.subscribers.delete(sub);
    while (sub.waiters.length > 0) {
      const w = sub.waiters.shift();
      /* v8 ignore start -- reason: the while guard proves waiters is non-empty, so shift() always returns a value; the falsy-w arm is a noUncheckedIndexedAccess guard only */
      if (w) w.resolve({ done: true, value: undefined });
      /* v8 ignore stop -- reason: end of the unreachable noUncheckedIndexedAccess drain guard above */
    }
    if (state.subscribers.size === 0) {
      byKey.delete(keyOf(state.symbol, state.interval));
      releaseStream(state.memberId, state.stream);
    }
  };

  const port: KlineFetcher = {
    subscribeKlines(symbol, interval): KlineSubscription {
      const k = keyOf(symbol, interval);
      let state = byKey.get(k);
      const isNewKey = !state;
      if (!state) {
        state = {
          symbol,
          interval,
          stream: streamOf(symbol, interval),
          ring: [],
          subscribers: new Set(),
          coldLoading: false,
          windowCache: new Map(),
          ringGeneration: 0,
          memberId: -1, // assigned below on the isNewKey path
        };
        byKey.set(k, state);
      }
      const sub: SubscriberState = { queue: [], waiters: [], cancelled: false };
      state.subscribers.add(sub);
      // Bind for return.next() — TS narrows state to non-null here but the
      // captured `state` variable can no longer be reassigned safely after
      // this branch closes.
      const boundState = state;
      if (isNewKey) {
        // Greedy pool assignment: the first member with spare capacity, else a
        // new member (up to the hard ceiling, which throws). The 1024 cap is
        // guaranteed here before any send.
        const owner = assignStream(boundState.stream);
        boundState.memberId = owner.id;
        if (!owner.ws) {
          connect(owner);
        } else {
          sendRpc(owner, 'SUBSCRIBE', [boundState.stream]);
        }
        // Best-effort REST cold-load so loadWindow answers immediately even
        // before the first WS kline lands.
        void coldLoad(boundState);
      }
      const stream = queueAsyncIterable<ClosedKline>(sub, () => {
        cancelSubscriber(boundState, sub);
      });
      return {
        stream,
        unsubscribe(): void {
          cancelSubscriber(boundState, sub);
        },
      };
    },

    subscribeMiniTicker(symbol): MiniTickerSubscription {
      let state = tickersBySymbol.get(symbol);
      const isNewKey = !state;
      if (!state) {
        state = {
          symbol,
          stream: tickerStreamOf(symbol),
          subscribers: new Set<TickerSubscriberState>(),
          memberId: -1, // assigned below on the isNewKey path
        };
        tickersBySymbol.set(symbol, state);
      }
      const sub: TickerSubscriberState = { queue: [], waiters: [], cancelled: false };
      state.subscribers.add(sub);
      const boundState = state;
      if (isNewKey) {
        const owner = assignStream(boundState.stream);
        boundState.memberId = owner.id;
        if (!owner.ws) {
          connect(owner);
        } else {
          sendRpc(owner, 'SUBSCRIBE', [boundState.stream]);
        }
      }
      const cancel = (): void => {
        if (sub.cancelled) return;
        sub.cancelled = true;
        boundState.subscribers.delete(sub);
        while (sub.waiters.length > 0) {
          const w = sub.waiters.shift();
          /* v8 ignore start -- reason: the while guard proves waiters is non-empty, so shift() always returns a value; the falsy-w arm is a noUncheckedIndexedAccess guard only */
          if (w) w.resolve({ done: true, value: undefined });
          /* v8 ignore stop -- reason: end of the unreachable noUncheckedIndexedAccess drain guard above */
        }
        if (boundState.subscribers.size === 0) {
          tickersBySymbol.delete(boundState.symbol);
          releaseStream(boundState.memberId, boundState.stream);
        }
      };
      const stream = queueAsyncIterable<MiniTicker>(sub, cancel);
      return { stream, unsubscribe: cancel };
    },

    async loadWindow(symbol, interval, size): Promise<KlineWindow> {
      const k = keyOf(symbol, interval);
      const state = byKey.get(k);
      const readAtMs = now();
      // The memo is read before the ring-length guard so it covers the REST answer too: a size above the ring can never be served from the ring, so without this the fallback re-fetches every tick. The ring branch below is stale-free by construction — it slices and installs synchronously, and the ring mutates in exactly two places (fanOut and the cold-load rebuild) which both clear the memo beside the mutation, as does a WS close. The REST branch is not, because a candle can close while its request is in flight; the generation check at the install guards that. Every one of those invalidators is driven by a socket event, so an entry is also refused once it reaches MEMO_MAX_AGE_MS — that is the only check that still fires when no event can arrive at all.
      const memo = state?.windowCache.get(size);
      if (state !== undefined && memo !== undefined) {
        // A negative age counts as expired rather than as young: `now` defaults to `Date.now`, so an NTP correction or container resync can step the clock backwards under an installed entry, and a bare `<` reads that as fresh and serves the entry until the clock catches up. That is exactly the silent-stream case the bound exists for, where nothing else can invalidate.
        const ageMs = readAtMs - memo.installedAtMs;
        if (ageMs >= 0 && ageMs < MEMO_MAX_AGE_MS) return memo.window;
        // Dropped rather than left for the refetch below to overwrite, so an expired entry cannot keep counting against MAX_WINDOW_CACHE_ENTRIES on the path where that refetch throws and never installs anything.
        state.windowCache.delete(size);
      }
      if (state && state.ring.length >= size) {
        const window = state.ring.slice(Math.max(0, state.ring.length - size));
        rememberWindow(state, size, window, readAtMs, 'ring');
        return window;
      }
      // No subscriber yet, or the ring is shorter than requested — REST
      // fetch directly. This path does NOT add a subscriber or open the
      // WS; loadWindow is a pull-style cold seed, not a subscription.
      const gen = state?.ringGeneration;
      // Normalised once, and the slice bound and the short-window verdict below both read off it rather than off the raw `size`, so a request `restLimitFor` had to collapse always comes with a log line. Reading either off the raw value makes a NaN size a silent trap: `slice(NaN)` coerces the index to 0 so the window is whatever came back, and `length < NaN` is false so the warn never fires, leaving an empty window memoised for a full MEMO_MAX_AGE_MS. Identical to the raw value for every finite input.
      const closedNeeded = Number.isFinite(size) ? Math.max(Math.ceil(size), 1) : 1;
      const limit = restLimitFor(size);
      if (opts.weightGovernor) await opts.weightGovernor.reserve(KLINE_WEIGHT);
      const rows = await opts.fetchRestKlines(symbol, interval, limit);
      const window = rows.slice(Math.max(0, rows.length - closedNeeded));
      if (window.length < closedNeeded) {
        // A consumer that gates on a full window holds fail-closed until this fills, and its own "warming up" is logged at debug, so without this the hold has no visible cause. The two causes need telling apart and only one of them is recoverable: a symbol that simply has less history than asked for fills as candles close, while a request clamped at the endpoint ceiling can NEVER reach `requestedSize` and needs the operator to lower the window. The verdict is computed rather than left to the reader, because `limit === maxLimit` is not the discriminator it looks like: `size === MAX_CANDLE_WINDOW` lands on the maximum limit naturally rather than by clamping, and that is the single size `resolveCandleWindow` returns for every config at or above the ceiling, so reading the verdict off the limit would call the largest legitimate window unfillable. Carried in the payload so a log search can filter on it. The payload also carries the raw `requestedSize` beside the `normalisedSize` the request was actually built for: they differ exactly when the input needed collapsing, which is the diagnosis. Fires at most once per candle for a subscribed key, since the memo below answers the repeat calls.
        const unfillable = limit - 1 < closedNeeded;
        opts.logger.warn(
          {
            symbol,
            interval,
            requestedSize: size,
            normalisedSize: closedNeeded,
            returnedSize: window.length,
            limit,
            maxLimit: BINANCE_MAX_KLINE_LIMIT,
            unfillable,
          },
          unfillable
            ? 'kline-fetcher: requested window exceeds what one klines request can supply and can never fill'
            : 'kline-fetcher: REST returned fewer closed candles than the requested window',
        );
      }
      // Memoised only for a subscribed key whose ring did not move while the request was in flight. An unsubscribed key holds no state to invalidate, so a memo there could never be dropped on a candle close; a key whose ring DID move would be pinned to a pre-close window until the following close. The window is still returned either way — it is the freshest single answer this call has, and only the caching is skipped.
      // Stamped at the install rather than at the read above, so the age backstop measures how long the entry is SERVED and a slow round trip does not spend part of its life. That stamp is also why the install has to refuse a strictly newer entry: two loadWindow calls for the same (symbol, interval, size) run concurrently in production (one per interval per profile, on separate chains), both miss the memo and both fetch, and the one that STARTED first can land last — overwriting the newer candles with older ones AND re-stamping them as freshly installed, so the age backstop then serves the older answer for a further MEMO_MAX_AGE_MS. `readAtMs` orders the two calls by when each started, which is the only ordering either call can observe.
      if (state && state.ringGeneration === gen) {
        const current = state.windowCache.get(size);
        if (current === undefined || current.installedAtMs <= readAtMs) {
          rememberWindow(state, size, window, now(), 'rest');
        }
      }
      return window;
    },

    setOnReconnect(handler): void {
      onReconnect = handler;
    },

    subscriberCount(symbol, interval): number {
      return byKey.get(keyOf(symbol, interval))?.subscribers.size ?? 0;
    },

    activeKeyCount(): number {
      return byKey.size;
    },

    isConnected(): boolean {
      // Aggregate all-open: true iff every non-empty member is OPEN. A member's
      // `ws` is set the moment `connect(m)` constructs the socket, but `send`
      // throws while CONNECTING — so "connected" means OPEN, not the
      // constructor sentinel. A partially-stalled pool (one member down) reads
      // false so the watchdog recovers the whole feed. Empty pool → false.
      if (members.length === 0) return false;
      return members.every((m) => m.ws !== null && m.isOpen);
    },

    msSinceLastFrame(): number {
      // Worst case across members: a single stalled member is enough to trip the
      // watchdog. Empty pool falls back to time since construction (bounded). The
      // oldest (smallest) lastFrameMs is the worst case → largest elapsed.
      if (members.length === 0) return now() - constructedAtMs;
      const oldest = Math.min(...members.map((m) => m.lastFrameMs));
      return now() - oldest;
    },

    forceReconnect(): void {
      // No-op when stopped: there is nothing to recover (the reconnect schedule,
      // if any, owns recovery). Otherwise force-reconnect EVERY open member so
      // the watchdog recovers the whole feed; a member that is mid-connect or
      // already closed is skipped (its own onClose-armed reconnect owns it).
      if (stopped) return;
      for (const m of members) {
        if (m.ws === null || !m.isOpen) continue;
        const dead = m.ws;
        // Flip to not-open synchronously so a second forceReconnect before
        // `onClose` fires is a no-op for this member, and so a caller can observe
        // the aggregate isConnected() === false in the same pass. `onClose` nulls
        // `m.ws` and schedules the reconnect + resubscribe (rebuilt from the
        // member's own activeStreams).
        m.isOpen = false;
        opts.logger.warn(
          { memberId: m.id },
          'kline-fetcher: forcing reconnect to recover a stalled feed',
        );
        try {
          dead.close();
        } catch (err) {
          // The production BinanceWs.close already swallows its own throw, so this
          // is defense-in-depth. Recovery rides the same onClose-armed reconnect
          // the whole adapter depends on; logging at warn keeps a throwing close
          // from being a silent failure, and the watchdog's REST gap-fill keeps
          // the strategy fed meanwhile.
          opts.logger.warn({ memberId: m.id, err: err }, 'kline-fetcher: forced close threw');
        }
      }
    },

    async shutdown(): Promise<void> {
      stopped = true;
      // Drop any RPCs buffered during the connect window on every member.
      // `onClose` also clears them, but the close handler may not run
      // synchronously for every underlying ws implementation.
      for (const m of members) {
        m.pendingSubscribes.clear();
        m.pendingUnsubscribes.clear();
      }
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
        state.subscribers.clear();
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
        tk.subscribers.clear();
      }
      tickersBySymbol.clear();
      for (const m of members) {
        if (m.ws) {
          m.ws.close();
          m.ws = null;
        }
      }
      members.length = 0;
    },
  };

  return port;
};
