// account-snapshot-safety cron storage helpers.
//
// `persistAccount` writes the `account-info` Redis key the tick's
// snapshot-loader reads (`buildAccountInfoKey`), serialised to the same
// `{ balances: { ASSET: { free, locked } } }` shape `parseAccountSnapshot`
// expects. A short TTL means the value expires once the WS recovers and
// the cron stops refreshing — the tick then falls back to its own
// cold-load REST path rather than reading a value the cron froze.
//
// `lastWsEventMs` reads the WS-liveness marker the EventRouter stamps;
// the cron uses it to skip the REST refresh while the stream is healthy.

import type { Redis } from 'ioredis';
import type { AccountId, ProfileId } from '@app/contracts';
import { buildAccountInfoKey, buildUserStreamEventKey } from 'executor/redis-namespace.js';
import { ACCOUNT_INFO_TTL_S, writeAccountInfo } from 'lib/account-info-writer.js';
import { writeAccountPermissions } from 'lib/account-permissions.js';

type BalanceMap = Record<string, { free: string; locked: string }>;

/**
 * The balance map a cached `account-info` value holds, or null when there is no
 * usable snapshot to merge into (absent key, non-JSON, or a `balances` that is
 * missing / an array / null — `typeof []` and `typeof null` are both 'object',
 * so a corrupt shape must not be spread into index-keyed entries).
 */
const readBalances = (raw: string | null): BalanceMap | null => {
  if (raw === null) return null;
  let parsed: { balances?: BalanceMap };
  try {
    parsed = JSON.parse(raw) as { balances?: BalanceMap };
  } catch {
    return null;
  }
  const { balances } = parsed;
  if (!balances || typeof balances !== 'object' || Array.isArray(balances)) return null;
  return balances;
};

export interface AccountSnapshotStore {
  /**
   * Replace the whole `account-info` snapshot. The caller MUST pass the full
   * balance set (every held asset) — used by the safety cron, which reads it
   * from `getAccount`. Overwrite is correct there: an asset absent from
   * `getAccount` is genuinely zero and must drop out of the cache.
   */
  readonly persistAccount: (
    accountId: AccountId,
    profileId: ProfileId,
    balances: readonly { asset: string; free: string; locked: string }[],
  ) => Promise<void>;
  /**
   * Patch only the given assets into the existing snapshot, leaving every
   * other asset untouched. Used for the `outboundAccountPosition` WS event,
   * whose `B` array is a DELTA — only the assets the triggering trade changed,
   * NOT the full account (Binance user-data-stream spec). Overwriting the
   * cache with that delta blanks every unchanged asset, so a position the bot
   * still holds reads as zero free balance until the cron repopulates — which
   * it does NOT while the WS is healthy, because the cron skips its REST
   * refresh. Merging keeps the snapshot whole between full refreshes.
   *
   * With no usable snapshot to merge into, this writes NOTHING: a delta-only
   * value is a truncated snapshot, and a truncated snapshot lies (see the
   * implementation). An absent key is the honest state — it reads back as
   * "unknown", and the safety cron rebuilds it.
   */
  readonly mergeAccount: (
    accountId: AccountId,
    profileId: ProfileId,
    changed: readonly { asset: string; free: string; locked: string }[],
  ) => Promise<void>;
  readonly lastWsEventMs: (accountId: AccountId, profileId: ProfileId) => Promise<number | null>;
  /**
   * True iff the `account-info` snapshot key currently exists. The safety
   * cron reads this so it does NOT skip its REST refresh when the WS marker is
   * fresh but the cache has already expired. Only `account-position` frames
   * write the cache, yet EVERY user-stream event (e.g. `executionReport`)
   * stamps the WS marker — so a stretch of order churn with no balance change
   * keeps the marker fresh while the 35s key lapses, blanking the dashboard
   * until the next real balance change. Gating the skip on cache presence
   * closes that hole.
   */
  readonly accountInfoExists: (accountId: AccountId, profileId: ProfileId) => Promise<boolean>;
  /**
   * Cache the permission tags from the same `getAccount` response that fed
   * `persistAccount`. Account-scoped, not profile-scoped: the tags belong to
   * the key pair. Lives on this store so the callers that already hold it need
   * no second Redis handle.
   */
  readonly persistAccountPermissions: (
    accountId: AccountId,
    permissions: readonly string[] | undefined,
  ) => Promise<void>;
}

export const createAccountSnapshotStore = (redis: Redis): AccountSnapshotStore => ({
  persistAccount: (accountId, profileId, balances) =>
    writeAccountInfo(redis, accountId, profileId, balances),
  mergeAccount: async (accountId, profileId, changed) => {
    const key = buildAccountInfoKey(accountId, profileId);
    // Read-modify-write the existing snapshot. This is NOT atomic: the user
    // stream dispatches frames without awaiting, so two account-position frames
    // for one (user, profile) can interleave and the later write wins, dropping
    // the other's update. That is acceptable for a balance cache — a dropped
    // update self-corrects on the next frame touching that asset (Binance sends
    // each changed asset's absolute free/locked, not a running delta) or on the
    // safety cron's next full refresh.
    const base = readBalances(await redis.get(key));
    // Without a usable base, this delta alone would be a TRUNCATED snapshot — and
    // the strategy reads an asset absent from a POPULATED map as a hard zero. So
    // writing it would assert "you hold nothing but this one asset": no cash, no
    // coins. Worse, the key would then exist, so the safety cron skips the REST
    // refresh that would have rebuilt the truth. Write nothing instead: the key
    // stays absent, the map the tick loads stays EMPTY (an honest "unknown", which
    // the sizing paths fail open on), and the cron rebuilds full truth on its next
    // pass.
    if (base === null) return;
    const balances: BalanceMap = { ...base };
    for (const b of changed) balances[b.asset] = { free: b.free, locked: b.locked };
    await redis.set(key, JSON.stringify({ balances }), 'EX', ACCOUNT_INFO_TTL_S);
  },
  lastWsEventMs: async (accountId, profileId) => {
    const raw = await redis.get(buildUserStreamEventKey(accountId, profileId));
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  },
  accountInfoExists: async (accountId, profileId) =>
    (await redis.exists(buildAccountInfoKey(accountId, profileId))) === 1,
  persistAccountPermissions: (accountId, permissions) =>
    writeAccountPermissions(redis, accountId, permissions),
});
