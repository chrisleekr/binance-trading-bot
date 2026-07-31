import { afterEach, describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { Redis } from 'ioredis';
import { createSymbolInfoCache } from '../../src/tick/symbol-info-cache.js';
import * as symbolInfoCacheMod from '../../src/tick/symbol-info-cache.js';
import { buildSymbolInfoKey } from '../../src/executor/redis-namespace.js';
import { errorMessage } from '@app/core/error';

// The typed error the confirmed-absent (delisted) throw becomes: `class
// SymbolDelistedError extends Error { symbol; mode }`. Read off the module
// namespace (never a named import) so this test file still loads while the class
// does not yet exist — it is `undefined` until the fix exports it, and the C6
// assertions below fail on that until then.
const SymbolDelistedError = (symbolInfoCacheMod as Record<string, unknown>)[
  'SymbolDelistedError'
] as (new (...args: unknown[]) => Error) | undefined;

const silentLogger = pino({ level: 'silent' });

interface RedisStore {
  data: Map<string, string>;
  get: ReturnType<typeof vi.fn>;
}

const stubRedis = (initial: Record<string, string> = {}): Redis & RedisStore => {
  const data = new Map<string, string>(Object.entries(initial));
  const obj = {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
  };
  return obj as unknown as Redis & RedisStore;
};

describe('createSymbolInfoCache', () => {
  const symbolInfo = {
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    status: 'TRADING',
    filters: {
      minPrice: '0.01',
      maxPrice: '1000000',
      tickSize: '0.01',
      minQty: '0.0001',
      maxQty: '9000',
      stepSize: '0.0001',
      minNotional: '10',
    },
  };

  it('returns symbol-info from the Redis cache without calling refresh', async () => {
    const redis = stubRedis({ [buildSymbolInfoKey('BTCUSDT')]: JSON.stringify(symbolInfo) });
    const refresh = vi.fn(async () => undefined);
    const cache = createSymbolInfoCache({
      redis,
      logger: silentLogger,
      refreshExchangeInfo: refresh,
    });

    const result = await cache.get('BTCUSDT');

    expect(result).toEqual(symbolInfo);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('primes the cache via refresh on first-tick miss, then returns from cache', async () => {
    const redis = stubRedis();
    const refresh = vi.fn(async () => {
      // simulate the refresher writing the key
      redis.data.set(buildSymbolInfoKey('BTCUSDT'), JSON.stringify(symbolInfo));
    });
    const cache = createSymbolInfoCache({
      redis,
      logger: silentLogger,
      refreshExchangeInfo: refresh,
    });

    const result = await cache.get('BTCUSDT');

    expect(result).toEqual(symbolInfo);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('throws a typed SymbolDelistedError when even refresh cannot find the symbol (delisted)', async () => {
    const redis = stubRedis();
    const refresh = vi.fn(async () => undefined); // refresh fails to populate
    const cache = createSymbolInfoCache({
      redis,
      logger: silentLogger,
      refreshExchangeInfo: refresh,
    });

    // C6: a confirmed-absent symbol is a distinct, catchable error type — not a bare
    // Error — carrying the symbol and mode so the handler can self-heal (reap) it.
    const err = await cache.get('NONEXISTENT', 'test').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SymbolDelistedError);
    expect(errorMessage(err)).toMatch(/not in Binance exchangeInfo/);
    expect((err as { symbol?: string }).symbol).toBe('NONEXISTENT');
    expect((err as { mode?: string }).mode).toBe('test');
  });

  describe('mode-aware (live vs test keyspace)', () => {
    // Testnet publishes a coarser tickSize than production for the same symbol;
    // the cache must keep them apart so a test-mode tick never prices off the
    // production filter (the -1013 PRICE_FILTER bug this fix closes).
    const testnetInfo = { ...symbolInfo, filters: { ...symbolInfo.filters, tickSize: '0.1' } };

    it('reads the test keyspace and refreshes with mode=test on a miss', async () => {
      const redis = stubRedis();
      const refresh = vi.fn(async (mode: string) => {
        if (mode === 'test') {
          redis.data.set(buildSymbolInfoKey('BTCUSDT', 'test'), JSON.stringify(testnetInfo));
        }
      });
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      const result = await cache.get('BTCUSDT', 'test');

      expect(result).toEqual(testnetInfo);
      expect(refresh).toHaveBeenCalledWith('test');
    });

    it('keeps live and test entries independent — a live hit never serves a test get', async () => {
      const redis = stubRedis({
        [buildSymbolInfoKey('BTCUSDT')]: JSON.stringify(symbolInfo),
        [buildSymbolInfoKey('BTCUSDT', 'test')]: JSON.stringify(testnetInfo),
      });
      const refresh = vi.fn(async () => undefined);
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      expect(await cache.get('BTCUSDT', 'live')).toEqual(symbolInfo);
      expect(await cache.get('BTCUSDT', 'test')).toEqual(testnetInfo);
      // Distinct Redis keys served both; neither needed a refresh.
      expect(refresh).not.toHaveBeenCalled();
    });

    it('defaults to the live keyspace when mode is omitted', async () => {
      const redis = stubRedis({ [buildSymbolInfoKey('BTCUSDT')]: JSON.stringify(symbolInfo) });
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: async () => undefined,
      });

      expect(await cache.get('BTCUSDT')).toEqual(symbolInfo);
    });
  });

  describe('per-mode in-flight collapse', () => {
    it('collapses concurrent same-mode misses onto a single refresh', async () => {
      const redis = stubRedis();
      let releaseRefresh: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const refresh = vi.fn(async (mode: 'live' | 'test') => {
        await gate; // hold the refresh open so both gets subscribe to one promise
        redis.data.set(buildSymbolInfoKey('BTCUSDT', mode), JSON.stringify(symbolInfo));
      });
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      const both = Promise.all([cache.get('BTCUSDT', 'test'), cache.get('BTCUSDT', 'test')]);
      releaseRefresh();
      const [a, b] = await both;

      expect(a).toEqual(symbolInfo);
      expect(b).toEqual(symbolInfo);
      // Thundering-herd collapse: two overlapping misses → exactly one fetch.
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith('test');
    });

    it('runs a live miss and a test miss as two independent refreshes', async () => {
      const redis = stubRedis();
      const refresh = vi.fn(async (mode: 'live' | 'test') => {
        redis.data.set(buildSymbolInfoKey('BTCUSDT', mode), JSON.stringify(symbolInfo));
      });
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      await Promise.all([cache.get('BTCUSDT', 'live'), cache.get('BTCUSDT', 'test')]);

      // Distinct modes do NOT collapse onto each other — one fetch per host.
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(refresh.mock.calls.map((c) => c[0]).sort()).toEqual(['live', 'test']);
    });
  });

  describe('in-process cache', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('serves the second call from the in-process cache without hitting Redis', async () => {
      const redis = stubRedis({ [buildSymbolInfoKey('BTCUSDT')]: JSON.stringify(symbolInfo) });
      const refresh = vi.fn(async () => undefined);
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      await cache.get('BTCUSDT');
      await cache.get('BTCUSDT');
      await cache.get('BTCUSDT');

      // First call hit Redis once; subsequent calls served from the Map.
      expect(redis.get).toHaveBeenCalledTimes(1);
    });

    it('refetches from Redis after the TTL elapses', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-28T00:00:00Z'));
      const redis = stubRedis({ [buildSymbolInfoKey('BTCUSDT')]: JSON.stringify(symbolInfo) });
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: async () => undefined,
      });

      await cache.get('BTCUSDT');
      // Within TTL: still 1 GET.
      vi.setSystemTime(new Date('2026-05-28T00:00:59Z'));
      await cache.get('BTCUSDT');
      expect(redis.get).toHaveBeenCalledTimes(1);

      // Step past TTL (60s): next call must refetch.
      vi.setSystemTime(new Date('2026-05-28T00:01:01Z'));
      await cache.get('BTCUSDT');
      expect(redis.get).toHaveBeenCalledTimes(2);
    });

    it('caches the refresh-path payload so the next tick is also cache-hot', async () => {
      const redis = stubRedis();
      const refresh = vi.fn(async () => {
        redis.data.set(buildSymbolInfoKey('BTCUSDT'), JSON.stringify(symbolInfo));
      });
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      await cache.get('BTCUSDT'); // miss + refresh + post-refresh GET
      const getCalls = redis.get.mock.calls.length;
      await cache.get('BTCUSDT'); // must be cache-hot

      expect(redis.get.mock.calls.length).toBe(getCalls);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('bounds the delisting refetch — retries within the negative TTL reuse one refresh', async () => {
      // #667: replaces the old "every retry reruns refresh" assertion. A
      // confirmed-absent symbol used to re-run the ungoverned full
      // /exchangeInfo fetch on EVERY get; the negative-TTL cache now serves the
      // typed throw from memory within the window, so refresh runs at most once.
      const redis = stubRedis();
      const refresh = vi.fn(async () => undefined);
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      const first = await cache.get('GONE').catch((e: unknown) => e);
      const second = await cache.get('GONE').catch((e: unknown) => e);

      // Each retry still raises the typed delisted error (never downgraded to a
      // bare Error), but the ungoverned refetch is bounded to a single fetch.
      expect(first).toBeInstanceOf(SymbolDelistedError);
      expect(second).toBeInstanceOf(SymbolDelistedError);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('isolates the cache to one instance (worker restart re-warms)', async () => {
      const redis = stubRedis({ [buildSymbolInfoKey('BTCUSDT')]: JSON.stringify(symbolInfo) });
      const refresh = vi.fn(async () => undefined);

      const cacheA = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });
      await cacheA.get('BTCUSDT');
      const callsAfterA = redis.get.mock.calls.length;

      const cacheB = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });
      await cacheB.get('BTCUSDT');

      // Instance B is a fresh cache, so it must re-read from Redis once.
      expect(redis.get.mock.calls.length).toBe(callsAfterA + 1);
    });
  });

  describe('negative-TTL cache for delisted symbols (#667)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('C6: bounds the refetch — N gets within the negative TTL run refresh at most once', async () => {
      // Core of #667. A held/not-auto delisted symbol used to re-run the
      // ungoverned full /exchangeInfo fetch on EVERY get. The negative-TTL
      // cache serves the typed throw from memory within the window, so refresh
      // fires at most once across N gets. RED start: today refresh runs N times.
      const redis = stubRedis();
      const refresh = vi.fn(async () => undefined); // never populates → confirmed-absent
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      const errors: unknown[] = [];
      for (let i = 0; i < 5; i += 1) {
        errors.push(await cache.get('GONEUSDT', 'test').catch((e: unknown) => e));
      }

      // Every get still throws the typed delisted error.
      for (const err of errors) {
        expect(err).toBeInstanceOf(SymbolDelistedError);
      }
      // But the ungoverned exchangeInfo refetch is bounded to a single fetch.
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('C2: records a negative entry on first delist, so a second get in-window skips refresh', async () => {
      const redis = stubRedis();
      const refresh = vi.fn(async () => undefined);
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      const first = await cache.get('GONEUSDT').catch((e: unknown) => e);
      const second = await cache.get('GONEUSDT').catch((e: unknown) => e);

      expect(first).toBeInstanceOf(SymbolDelistedError);
      expect(second).toBeInstanceOf(SymbolDelistedError);
      // Second get is served from the negative cache — no second refresh.
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('C3: refreshes again after the negative TTL expires', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-28T00:00:00Z'));
      // The negative TTL must equal the positive TTL (60s) once the fix exports it.
      // Assert the raw export directly (no ?? fallback) so a missing or renamed
      // export fails here instead of being masked. It must equal the positive TTL.
      const rawNegTtl = (symbolInfoCacheMod as Record<string, unknown>)[
        'SYMBOL_INFO_NEGATIVE_TTL_MS'
      ];
      expect(rawNegTtl).toBeDefined();
      expect(rawNegTtl).toBe(60_000);

      const redis = stubRedis();
      const refresh = vi.fn(async () => undefined);
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      await cache.get('GONEUSDT').catch(() => undefined);
      // Within the negative TTL: still bounded to one refresh.
      vi.setSystemTime(new Date('2026-05-28T00:00:59Z'));
      await cache.get('GONEUSDT').catch(() => undefined);
      expect(refresh).toHaveBeenCalledTimes(1);

      // Step past the negative TTL (60s): next get must refetch afresh.
      vi.setSystemTime(new Date('2026-05-28T00:01:01Z'));
      await cache.get('GONEUSDT').catch(() => undefined);
      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('C4: a re-listed symbol returns SymbolInfo and clears the negative entry', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-28T00:00:00Z'));
      const redis = stubRedis();
      let relisted = false;
      const refresh = vi.fn(async () => {
        // Operator re-lists on Binance after the first (absent) refresh.
        if (relisted) {
          redis.data.set(buildSymbolInfoKey('RELISTUSDT'), JSON.stringify(symbolInfo));
        }
      });
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      // First get: absent → typed throw, negative entry recorded.
      const first = await cache.get('RELISTUSDT').catch((e: unknown) => e);
      expect(first).toBeInstanceOf(SymbolDelistedError);

      // Re-list, then step past the negative TTL so the next get refreshes.
      relisted = true;
      vi.setSystemTime(new Date('2026-05-28T00:01:01Z'));
      const revived = await cache.get('RELISTUSDT');
      expect(revived).toEqual(symbolInfo);

      // Negative entry is cleared: an immediate follow-up get does NOT throw.
      const followUp = await cache.get('RELISTUSDT');
      expect(followUp).toEqual(symbolInfo);
    });

    it('C5: a test-mode negative entry does not suppress a live-mode refresh', async () => {
      // Redis starts EMPTY so the live get MISSES and must reach the negative-cache
      // check — the only way this test can prove the negative entry is keyed by
      // `${mode}:${symbol}`. If it were mis-keyed as bare `BTCUSDT`, the live get
      // would hit the test-mode negative and throw instead of refreshing.
      const redis = stubRedis();
      const refresh = vi.fn(async (mode: string) => {
        // test host has no such symbol (stays absent); live host lists it.
        if (mode === 'live') {
          redis.data.set(buildSymbolInfoKey('BTCUSDT', 'live'), JSON.stringify(symbolInfo));
        }
      });
      const cache = createSymbolInfoCache({
        redis,
        logger: silentLogger,
        refreshExchangeInfo: refresh,
      });

      // test-mode delist records a `test:BTCUSDT` negative entry.
      const testErr = await cache.get('BTCUSDT', 'test').catch((e: unknown) => e);
      expect(testErr).toBeInstanceOf(SymbolDelistedError);

      // live-mode get MISSES Redis, reaches the negative check, finds no `live:`
      // entry (the negative is keyed `test:BTCUSDT`), so it refreshes with mode
      // 'live' and returns the info — the test negative did not shadow it.
      expect(await cache.get('BTCUSDT', 'live')).toEqual(symbolInfo);
      expect(refresh).toHaveBeenCalledWith('live');
    });
  });
});
