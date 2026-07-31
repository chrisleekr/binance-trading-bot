import type { AccountId, ProfileId } from '@app/contracts';
import { profilePrefix, type ScopedRedis } from '@app/db';

// Wipe every Redis key under tenant:<accountId>:profile:<p>:* using SCAN+DEL.
export const wipeProfileRedis = async (
  redis: ScopedRedis,
  accountId: AccountId,
  profileId: ProfileId,
): Promise<number> => {
  const r = redis.raw();
  const prefix = profilePrefix({ accountId, profileId });
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await r.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
    cursor = next;
    if (keys.length > 0) {
      removed += await r.del(...keys);
    }
  } while (cursor !== '0');
  return removed;
};

// Every profile-scoped key that names a symbol uses the symbol as a terminal
// path component (configurations:<S>, open-orders:<S>, override:<S>,
// disable-action:<S>). Match strictly on `:<symbol>` suffix so wiping `BTC`
// does not also wipe `BTCUSDT` keys. Symbol-global market data (ticker:<S>,
// binance:symbol-info:<S>) is not profile-scoped and is intentionally left alone.
export const wipeSymbolRedis = async (
  redis: ScopedRedis,
  accountId: AccountId,
  profileId: ProfileId,
  symbol: string,
): Promise<number> => {
  const r = redis.raw();
  const prefix = profilePrefix({ accountId, profileId });
  const suffix = `:${symbol}`;
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await r.scan(cursor, 'MATCH', `${prefix}*${suffix}`, 'COUNT', 500);
    cursor = next;
    const filtered = keys.filter((k) => k.endsWith(suffix));
    if (filtered.length > 0) {
      removed += await r.del(...filtered);
    }
  } while (cursor !== '0');
  return removed;
};
