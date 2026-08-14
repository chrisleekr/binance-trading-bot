// Single source of truth for the `account-permissions` Redis key's shape.
//
// Binance gates each symbol on permission tags: a symbol is tradable only when
// the account holds at least one tag from every set the symbol publishes. The
// tags live on the signed `/account` response, so every code path that already
// pays for that call writes them here, and the order pre-flight reads them back
// without a signed call of its own.
//
// Absent means UNKNOWN, never "holds nothing": both the writer and the reader
// fail open, so a cold cache or an unreadable Redis can only ever let an order
// through, never invent a refusal.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { AccountId } from '@app/contracts';
import { parseAccountPermissions } from '@app/contracts';
import { buildAccountPermissionsKey } from 'executor/redis-namespace.js';

/**
 * Cache the account's permission tags. A missing or empty list is NOT written:
 * permissions change only when the operator edits the key pair's Binance
 * settings, so a response that omits them is a degraded read, and clobbering a
 * good cached list with an empty one would read back as "unknown" and disarm
 * the pre-flight until the next healthy fetch.
 *
 * The key is intentionally TTL-less. See `accountPermissionsKey` in `@app/db`.
 */
export const writeAccountPermissions = async (
  redis: Redis,
  accountId: AccountId,
  permissions: readonly string[] | undefined,
): Promise<void> => {
  if (permissions === undefined || permissions.length === 0) return;
  await redis.set(buildAccountPermissionsKey(accountId), JSON.stringify(permissions));
};

/**
 * Read the cached tags, degrading a Redis fault to the empty "unknown" list.
 *
 * Never throws, the same contract `fetchSymbolAdmission` holds. The discovery
 * handler memoizes this per account for a whole wake, so a rejection would be
 * replayed to every remaining profile on that account and skip each one: a
 * transient Redis blip would cost the wake rather than one optional cut.
 */
export const readAccountPermissions = async (
  redis: Pick<Redis, 'get'>,
  logger: Pick<Logger, 'warn'>,
  accountId: AccountId,
  logPrefix: string,
): Promise<readonly string[]> => {
  try {
    return parseAccountPermissions(await redis.get(buildAccountPermissionsKey(accountId)));
  } catch (err) {
    logger.warn(
      { accountId, err: err },
      `${logPrefix}: account-permissions read failed; permission cut skipped`,
    );
    return [];
  }
};

// The parser lives in `@app/contracts` next to the tradability rule itself, so
// the api's bind-time guard and the worker's order pre-flight cannot drift on
// what a cached value means. Re-exported here so callers reach the writer and
// the reader through one module.
export { parseAccountPermissions } from '@app/contracts';
