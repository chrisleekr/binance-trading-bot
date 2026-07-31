import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { BinanceMode } from '@app/binance';
import type { SymbolInfo } from '@app/strategy-core';

import { buildSymbolInfoKey } from 'executor/redis-namespace.js';
import { createExchangeInfoRefresh } from 'crons/exchange-info-refresh.js';

/**
 * A (symbol, mode) that Binance's exchangeInfo confirms it no longer lists: the
 * inline refresh RESOLVED, yet the symbol key is still absent. This is a
 * different fact from a transient read failure (a thrown refresh, a non-2xx, a
 * Redis error) — those stay bare `Error` and dead-letter for a human. This one
 * will never resolve on its own, so it is a typed error the tick handler catches
 * to self-heal: reap the auto-added binding instead of dead-lettering the same
 * symbol every tick forever. Carries `symbol` and `mode` so the handler can act
 * without re-parsing the message. Name/shape mirror `RedisUnavailableError`.
 */
export class SymbolDelistedError extends Error {
  readonly symbol: string;
  readonly mode: BinanceMode;
  constructor(symbol: string, mode: BinanceMode) {
    super(
      `symbol-info-cache: symbol ${symbol} (mode ${mode}) not in Binance exchangeInfo after refresh`,
    );
    this.name = 'SymbolDelistedError';
    this.symbol = symbol;
    this.mode = mode;
  }
}

/**
 * Reads symbol filters/status for the tick's `MarketSnapshot`. A deep
 * module: callers see one `get(symbol)` method; behind it sits an
 * in-process cache, the Redis copy the exchange-info-refresh cron
 * populates, a thundering-herd collapse, and the inline first-tick prime.
 * This is unrelated to the per-(profile, symbol) Redis-miss fallbacks in
 * {@link SnapshotColdLoad}, so it lives in its own module.
 */
export interface SymbolInfoCache {
  /**
   * Symbol filters for the given Binance `mode` (defaults to `live`). A
   * test-mode profile MUST pass `'test'` so it reads testnet's own tickSize /
   * lot filters — production filters are finer and get rejected on testnet.
   */
  get(symbol: string, mode?: BinanceMode): Promise<SymbolInfo>;
}

/**
 * Dependencies for the production {@link SymbolInfoCache}. `refreshExchangeInfo`
 * is overridable so unit tests can substitute the recovery path that runs
 * on a symbol-info cache miss.
 */
export interface SymbolInfoCacheDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  // Per-mode inline refresh, run on a cache miss to prime the mode's keyspace.
  // Overridable so unit tests can substitute the recovery path. Defaults to a
  // per-mode `createExchangeInfoRefresh`.
  readonly refreshExchangeInfo?: (mode: BinanceMode) => Promise<unknown>;
}

/**
 * Symbol-info cache TTL. Symbol info is written by the
 * `exchange-info-refresh` cron every 5 minutes; a 60s in-process TTL keeps
 * the stale window to at most one tick post-cron-write. A delisting
 * surfaces after at most `SYMBOL_INFO_TTL_MS + exchange-info-refresh
 * interval` (the cache must expire AND the cron must overwrite Redis with
 * the new exchangeInfo that omits the symbol). Pubsub was rejected as the
 * invalidation channel because it adds a subscriber lifecycle + ordering
 * risk for a value with a coarse 5-minute refresh cadence. Worker is
 * single-replica in v1.0, so an in-process `Map` is the single source of
 * truth.
 */
const SYMBOL_INFO_TTL_MS = 60_000;

/**
 * Negative-cache TTL for a confirmed-absent (delisted) symbol. Within the
 * positive TTL the exchangeInfo can't have changed, so re-running the
 * ungoverned full /exchangeInfo fetch for a symbol we just confirmed absent is
 * pure waste. We cache the negative for this bounded window and keep throwing
 * `SymbolDelistedError` from memory; after it expires the next get refreshes
 * again so a re-listed symbol recovers. Kept `<=` the positive TTL so a stale
 * negative never outlives a fresh positive entry for the same key.
 */
export const SYMBOL_INFO_NEGATIVE_TTL_MS: number = SYMBOL_INFO_TTL_MS;

export const createSymbolInfoCache = (deps: SymbolInfoCacheDeps): SymbolInfoCache => {
  // Per-mode refresh closure: a test-mode miss must prime testnet's keyspace
  // from testnet's host, not production's.
  const refresh =
    deps.refreshExchangeInfo ??
    ((mode: BinanceMode) =>
      createExchangeInfoRefresh({ redis: deps.redis, logger: deps.logger, mode })());
  // Concurrent misses in the SAME mode share one promise; once it settles the
  // sentinel clears so the next miss after a refresh failure tries again.
  // Keyed by mode so a live miss and a test miss don't collapse onto each other.
  const inflight = new Map<BinanceMode, Promise<unknown>>();
  const refreshOnce = async (mode: BinanceMode): Promise<void> => {
    let pending = inflight.get(mode);
    if (pending === undefined) {
      pending = refresh(mode).finally(() => {
        inflight.delete(mode);
      });
      inflight.set(mode, pending);
    }
    await pending;
  };

  // In-process cache. Eliminates one Redis GET + one JSON.parse per tick on
  // the hot path; on a 60s TTL the hit rate is effectively 100% in steady
  // state. Cache lifetime is scoped to this instance, so a worker restart
  // re-warms naturally on first tick per symbol. Keyed by `<mode>:<symbol>` so
  // a symbol listed on both hosts keeps a distinct filter set per mode.
  const cache = new Map<string, { info: SymbolInfo; expiresAt: number }>();

  // Negative cache: a confirmed-absent (delisted) `<mode>:<symbol>` and the ms
  // at which the throttle on re-fetching it expires. Bounds the ungoverned
  // /exchangeInfo re-fetch — within the window `get` throws from memory without
  // running refresh; a found result clears the entry. Keyed identically to the
  // positive cache for live/test isolation.
  const absent = new Map<string, number>();

  return {
    get: async (symbol: string, mode: BinanceMode = 'live'): Promise<SymbolInfo> => {
      const now = Date.now();
      const cacheKey = `${mode}:${symbol}`;
      const cachedEntry = cache.get(cacheKey);
      if (cachedEntry !== undefined && cachedEntry.expiresAt > now) {
        return cachedEntry.info;
      }
      const key = buildSymbolInfoKey(symbol, mode);
      const cached = await deps.redis.get(key);
      if (cached !== null) {
        const info = JSON.parse(cached) as SymbolInfo;
        cache.set(cacheKey, { info, expiresAt: now + SYMBOL_INFO_TTL_MS });
        absent.delete(cacheKey);
        return info;
      }
      // Confirmed-absent within the negative TTL: throw from memory without
      // re-running the ungoverned refresh. Still throws every get so the
      // tick-handler reaper fires each tick; only the refetch is bounded.
      const absentUntil = absent.get(cacheKey);
      if (absentUntil !== undefined && absentUntil > now) {
        throw new SymbolDelistedError(symbol, mode);
      }
      absent.delete(cacheKey); // expired (or absent): fall through and retry refresh.
      // First-tick race: the refresh cron hasn't fired yet for a brand-new
      // worker (or this is the first tick in this mode). Run it inline so the
      // same tick can proceed instead of DLQing.
      deps.logger.warn({ symbol, mode }, 'symbol-info-cache: miss — priming exchangeInfo inline');
      await refreshOnce(mode);
      const refreshed = await deps.redis.get(key);
      if (refreshed === null) {
        // The refresh succeeded but THIS symbol still isn't present — Binance no
        // longer lists it. Surface so the operator sees the mistake instead of
        // ticking against ghost market data. Cache the negative for a bounded
        // window (SYMBOL_INFO_NEGATIVE_TTL_MS) so we don't re-run the full
        // /exchangeInfo fetch every get; after it expires we retry so a
        // re-listed symbol recovers.
        absent.set(cacheKey, now + SYMBOL_INFO_NEGATIVE_TTL_MS);
        throw new SymbolDelistedError(symbol, mode);
      }
      const info = JSON.parse(refreshed) as SymbolInfo;
      cache.set(cacheKey, { info, expiresAt: now + SYMBOL_INFO_TTL_MS });
      absent.delete(cacheKey);
      return info;
    },
  };
};
