import type { Redis } from 'ioredis';
import type { AccountId, ProfileId } from '@app/contracts';
import { minuteBucketOf } from './binance-error-taxonomy.js';
import { buildWeightKey } from './redis-namespace.js';

/**
 * Per-account Binance spot weight is bucketed by wall-clock minute. The
 * TTL is 120s so a bucket that straddles a minute boundary stays
 * readable while the next bucket warms — readers never observe a missing
 * key during the swap. See `redis-namespace.ts` for the bucket-key shape.
 */
export const DEFAULT_WEIGHT_TTL = 120;

export interface WeightLimiterDeps {
  readonly redis: Redis;
  readonly clock: { nowMs(): number };
  readonly weightTtlSeconds?: number;
}

/**
 * Write the Binance-reported `X-MBX-USED-WEIGHT-1m` value back to Redis
 * under the current minute-bucket key. No-op when Binance returned no
 * weight header (the client's ctx will be `undefined`) — overwriting with
 * 0 would erase the high-water mark from concurrent callers in the same
 * bucket.
 */
export const recordWeight = async (
  deps: WeightLimiterDeps,
  accountId: AccountId,
  profileId: ProfileId,
  weightUsed1m: number | undefined,
): Promise<void> => {
  if (weightUsed1m === undefined) return;
  const bucket = minuteBucketOf(deps.clock.nowMs());
  await deps.redis.set(
    buildWeightKey(accountId, profileId, bucket),
    String(weightUsed1m),
    'EX',
    deps.weightTtlSeconds ?? DEFAULT_WEIGHT_TTL,
  );
};

/**
 * Read the most-recently-recorded weight for the current minute bucket.
 * Returns 0 when the key is absent (cold start, TTL expiry, or fresh
 * bucket) so the caller's comparison against `weightLimit1m` short-circuits
 * cleanly without a null branch.
 */
export const readCurrentWeight = async (
  deps: WeightLimiterDeps,
  accountId: AccountId,
  profileId: ProfileId,
): Promise<number> => {
  const bucket = minuteBucketOf(deps.clock.nowMs());
  const raw = await deps.redis.get(buildWeightKey(accountId, profileId, bucket));
  return raw === null ? 0 : Number.parseInt(raw, 10) || 0;
};
