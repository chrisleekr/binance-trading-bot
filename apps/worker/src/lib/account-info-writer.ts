// Single source of truth for the `account-info` Redis key's shape and TTL.
// Two writers fill this key: the account-snapshot-safety cron (full-refresh
// `persistAccount`) and the tick cold-load's REST fallback write-through.
// Both must serialise the identical `{ balances: { ASSET: { free, locked } } }`
// shape and TTL the snapshot-loader reads, so the reshape/`set` lives here once
// rather than being copied at each call site.

import type { Redis } from 'ioredis';
import type { AccountId, ProfileId } from '@app/contracts';
import { buildAccountInfoKey } from 'executor/redis-namespace.js';

// Staleness threshold (30s) + cron interval (5s) + margin: long enough
// that an every-5s cron refresh never lets the key lapse, short enough that
// it expires soon after the WS recovers and the writers stop refreshing.
export const ACCOUNT_INFO_TTL_S = 35;

/**
 * Overwrite the whole `account-info` snapshot with the given full balance set.
 * The caller MUST pass every held asset (the authoritative `getAccount` view):
 * an asset absent from `balances` is genuinely zero and must drop out of the
 * cache. Serialises the map the snapshot-loader parses and stamps the shared TTL.
 */
export const writeAccountInfo = async (
  redis: Redis,
  accountId: AccountId,
  profileId: ProfileId,
  balances: readonly { asset: string; free: string; locked: string }[],
): Promise<void> => {
  const shaped = {
    balances: Object.fromEntries(
      balances.map((b) => [b.asset, { free: b.free, locked: b.locked }]),
    ),
  };
  await redis.set(
    buildAccountInfoKey(accountId, profileId),
    JSON.stringify(shaped),
    'EX',
    ACCOUNT_INFO_TTL_S,
  );
};
