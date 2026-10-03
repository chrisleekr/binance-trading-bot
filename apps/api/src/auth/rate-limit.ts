import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

/** A rate: at most `limit` events per `periodMs`, the whole allowance usable as a burst. */
export interface Rate {
  readonly limit: number;
  readonly periodMs: number;
}

/** A limiter's answer. `retryAfterMs` is exact when refused and 0 when allowed. */
export interface Decision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

/**
 * Shared rate-limit primitives. These are limiters, not locks: no key has an owner, nothing is released or refunded, and every key expires on its own, which is the shape `scripts/ci/no-locks.sh` permits.
 */
export interface RateLimiter {
  /** Takes one unit from `key`'s allowance under `rate`, or refuses without taking it. */
  consume(key: string, rate: Rate): Promise<Decision>;
  /** Milliseconds left on a flag (a block or a lockout), 0 when it is not set. */
  flagRemainingMs(key: string): Promise<number>;
  /** Sets a flag for `ttlMs`. Returns true only when it was not already set, so the caller can record the start of a block exactly once. */
  setFlag(key: string, ttlMs: number): Promise<boolean>;
  /** Resets the time left on a flag that is set. Does nothing when it is not, so a flag that expired or was cleared meanwhile is never recreated. */
  extendFlag(key: string, ttlMs: number): Promise<void>;
  /** Increments a counter that expires `ttlMs` after its first increment, and returns the new value. */
  countWithin(key: string, ttlMs: number): Promise<number>;
  /** Deletes keys, for the recovery command that clears a lockout. */
  clear(keys: readonly string[]): Promise<void>;
  /** Deletes every key starting with `prefix`, for the recovery command, which cannot name the blocked address: an operator locked out from the host rarely knows which address the server saw. */
  clearPrefix(prefix: string): Promise<void>;
}

/**
 * Generic Cell Rate Algorithm, evaluated atomically in Redis.
 *
 * Each key stores one number, the "theoretical arrival time" of the next allowed event. An event is allowed when that time, advanced by one emission interval (`period / limit`), is no more than one period ahead of now. Compared with the alternatives: a fixed window lets twice the limit through across a window boundary; a sliding log (the previous sorted-set design) stores one entry per attempt, so a flood grows Redis memory, and that Redis also carries the trading queue; a sliding-window counter only approximates. GCRA is exact, keeps one small key per subject, and yields a precise retry time. `TIME` is read inside the script so every api replica shares Redis's clock rather than its own.
 */
const GCRA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local interval = tonumber(ARGV[1])
local period = tonumber(ARGV[2])
local tat = tonumber(redis.call('GET', KEYS[1]) or now)
if tat < now then tat = now end
local newTat = tat + interval
local allowAt = newTat - period
if allowAt > now then
  return {0, math.ceil(allowAt - now)}
end
redis.call('SET', KEYS[1], tostring(newTat), 'PX', math.max(1, math.ceil(newTat - now)))
return {1, 0}
`;

const COUNT_WITHIN = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`;

/**
 * Deletes every Redis key starting with `prefix`, walking the keyspace with SCAN so a large keyspace never blocks Redis the way KEYS would. Throws on a Redis failure; callers decide whether to fall back.
 *
 * @param redis - The connection to delete through.
 * @param prefix - A literal key prefix containing no glob characters.
 */
export const deleteKeysWithPrefix = async (redis: Redis, prefix: string): Promise<void> => {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    if (keys.length > 0) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
};

type GcraRedis = Redis & {
  authGcra(key: string, interval: string, period: string): Promise<[number, number]>;
  authCountWithin(key: string, ttlMs: string): Promise<number>;
};

/** Largest number of keys the in-process fallback holds. It exists only while Redis is unreachable; beyond this the oldest entries are dropped. */
const FALLBACK_MAX_KEYS = 50_000;

/**
 * In-process implementation of the same primitives, used only while Redis cannot be reached. It is per replica, so across N replicas an attacker gets N allowances; to compensate each rate is halved. Better than answering 503, which would stop the operator reaching the kill switch during a Redis blip.
 *
 * @param now - Clock, injectable for tests.
 * @returns A limiter backed by process memory.
 */
export const createMemoryRateLimiter = (now: () => number = Date.now): RateLimiter => {
  const tats = new Map<string, number>();
  const flags = new Map<string, number>();
  const counters = new Map<string, { n: number; until: number }>();
  const bound = <V>(map: Map<string, V>): void => {
    while (map.size > FALLBACK_MAX_KEYS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
  return {
    async consume(key, rate) {
      const limit = Math.max(1, Math.floor(rate.limit / 2));
      const interval = rate.periodMs / limit;
      const t = now();
      const tat = Math.max(tats.get(key) ?? t, t);
      const newTat = tat + interval;
      const allowAt = newTat - rate.periodMs;
      if (allowAt > t) return { allowed: false, retryAfterMs: Math.ceil(allowAt - t) };
      tats.delete(key);
      tats.set(key, newTat);
      bound(tats);
      return { allowed: true, retryAfterMs: 0 };
    },
    async flagRemainingMs(key) {
      const until = flags.get(key);
      if (until === undefined) return 0;
      const left = until - now();
      if (left <= 0) flags.delete(key);
      return Math.max(0, left);
    },
    async setFlag(key, ttlMs) {
      const existing = flags.get(key);
      if (existing !== undefined && existing > now()) return false;
      flags.set(key, now() + ttlMs);
      bound(flags);
      return true;
    },
    async extendFlag(key, ttlMs) {
      const existing = flags.get(key);
      if (existing !== undefined && existing > now()) flags.set(key, now() + ttlMs);
    },
    async countWithin(key, ttlMs) {
      const t = now();
      const current = counters.get(key);
      const next =
        current !== undefined && current.until > t
          ? { n: current.n + 1, until: current.until }
          : { n: 1, until: t + ttlMs };
      counters.set(key, next);
      bound(counters);
      return next.n;
    },
    async clear(keys) {
      for (const key of keys) {
        tats.delete(key);
        flags.delete(key);
        counters.delete(key);
      }
    },
    async clearPrefix(prefix) {
      for (const map of [tats, flags, counters])
        for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    },
  };
};

/**
 * Redis-backed limiter that falls back to {@link createMemoryRateLimiter} for any call Redis fails, reporting each fallback so an outage is never silent.
 *
 * @param redis - A connection used only for these commands; the scripts are registered on it once.
 * @param onBackendError - Called for every call that fell back, with the error. The caller counts and alerts on it.
 * @param logger - Where fallbacks are logged.
 * @returns The limiter.
 */
export const createRedisRateLimiter = (
  redis: Redis,
  onBackendError: (err: unknown) => void,
  logger: Logger,
): RateLimiter => {
  const client = redis as GcraRedis;
  if (typeof client.authGcra !== 'function') {
    client.defineCommand('authGcra', { numberOfKeys: 1, lua: GCRA });
    client.defineCommand('authCountWithin', { numberOfKeys: 1, lua: COUNT_WITHIN });
  }
  const fallback = createMemoryRateLimiter();
  const guarded = async <T>(op: () => Promise<T>, local: () => Promise<T>): Promise<T> => {
    try {
      return await op();
    } catch (err) {
      logger.error({ err }, 'auth_rate_limit_backend_unavailable_using_local_limiter');
      onBackendError(err);
      return local();
    }
  };
  return {
    consume: (key, rate) =>
      guarded(
        async () => {
          const [allowed, retryAfterMs] = await client.authGcra(
            key,
            String(rate.periodMs / Math.max(1, rate.limit)),
            String(rate.periodMs),
          );
          return { allowed: allowed === 1, retryAfterMs: Number(retryAfterMs) };
        },
        () => fallback.consume(key, rate),
      ),
    flagRemainingMs: (key) =>
      guarded(
        async () => Math.max(0, await client.pttl(key)),
        () => fallback.flagRemainingMs(key),
      ),
    setFlag: (key, ttlMs) =>
      guarded(
        async () =>
          (await client.set(key, '1', 'PX', Math.max(1, Math.ceil(ttlMs)), 'NX')) === 'OK',
        () => fallback.setFlag(key, ttlMs),
      ),
    extendFlag: (key, ttlMs) =>
      guarded(
        async () => {
          await client.set(key, '1', 'PX', Math.max(1, Math.ceil(ttlMs)), 'XX');
        },
        () => fallback.extendFlag(key, ttlMs),
      ),
    countWithin: (key, ttlMs) =>
      guarded(
        async () =>
          Number(await client.authCountWithin(key, String(Math.max(1, Math.ceil(ttlMs))))),
        () => fallback.countWithin(key, ttlMs),
      ),
    clear: (keys) =>
      guarded(
        async () => {
          if (keys.length > 0) await client.del(...keys);
        },
        () => fallback.clear(keys),
      ),
    clearPrefix: (prefix) =>
      guarded(
        () => deleteKeysWithPrefix(client, prefix),
        () => fallback.clearPrefix(prefix),
      ),
  };
};

/**
 * A limiter that allows everything and never sets a flag. For test harnesses whose subject is not rate limiting; the rate-limit suites use the real limiter.
 *
 * @returns The permissive limiter.
 */
export const createUnlimitedRateLimiter = (): RateLimiter => ({
  consume: async () => ({ allowed: true, retryAfterMs: 0 }),
  flagRemainingMs: async () => 0,
  setFlag: async () => true,
  extendFlag: async () => {},
  countWithin: async () => 1,
  clear: async () => {},
  clearPrefix: async () => {},
});
