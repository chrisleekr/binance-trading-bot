/**
 * Narrow read/write surface over Redis that the projection layer depends
 * on. Routes pass `di.redis.raw()` (an ioredis client satisfies this
 * structurally); projection unit tests pass an in-memory stub. Keeping the
 * port minimal means a projection test never has to mock the full ioredis
 * surface — only the calls the projections actually make.
 */
export interface ProjectionRedis {
  get(key: string): Promise<string | null>;
  /**
   * Batched get. Returns values in key order; `null` for an absent key. The
   * caller must pass at least one key — `MGET` with no arguments is a Redis
   * error, so guard empty symbol/profile sets at the call site.
   */
  mget(...keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
  exists(key: string): Promise<number>;
}
