import type { ProjectionRedis } from '../../src/repo/projections/redis-port.js';

/**
 * In-memory {@link ProjectionRedis} for projection unit tests. `ttl()`
 * mirrors ioredis semantics: -2 for a missing key, the stored EX seconds
 * for a key set with a TTL, -1 for a key set without one.
 */
export const makeRedisStub = (
  seed: Record<string, string> = {},
): { redis: ProjectionRedis; store: Map<string, string>; ttls: Map<string, number> } => {
  const store = new Map<string, string>(Object.entries(seed));
  const ttls = new Map<string, number>();
  const redis: ProjectionRedis = {
    get: async (key) => store.get(key) ?? null,
    mget: async (...keys) => {
      // Redis/ioredis MGET errors on zero keys; mirror that so the projections'
      // empty-symbol guards are genuinely exercised rather than silently passing.
      if (keys.length === 0) throw new Error('ERR wrong number of arguments for mget');
      return keys.map((k) => store.get(k) ?? null);
    },
    // `mode` is always 'EX' — the ProjectionRedis port hard-codes it, so
    // every stub `set` records a TTL, mirroring the projections' usage.
    set: async (key, value, _mode, seconds) => {
      store.set(key, value);
      ttls.set(key, seconds);
      return 'OK';
    },
    ttl: async (key) => {
      if (!store.has(key)) return -2;
      return ttls.get(key) ?? -1;
    },
    exists: async (key) => (store.has(key) ? 1 : 0),
  };
  return { redis, store, ttls };
};
