import type { AccountId, UserId } from '@app/contracts';
import { eq } from 'drizzle-orm';
import { accounts } from '../schema/accounts.js';
import { apiKeys, type ApiKeyInsert, type ApiKeyRow } from '../schema/api-keys.js';
import type { Database } from './_db.js';
import type { AccountScope } from './_scoped.js';

/**
 * Read the single api-key row for an account. A legitimate empty state (operator
 * has not configured a key yet) returns `null`; cross-account access can never
 * reach here because the caller had to resolve an `AccountScope` first.
 */
export async function findForAccount(scope: AccountScope): Promise<ApiKeyRow | null> {
  const rows = await scope.db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.accountId, scope.accountId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Save the account's api key. Insert on first save, replace in place on
 * subsequent saves under the `api_keys_account_uniq` unique index, so two
 * concurrent saves on the same account collapse onto one row.
 */
export async function upsert(
  scope: AccountScope,
  input: Omit<ApiKeyInsert, 'accountId'>,
): Promise<ApiKeyRow> {
  const [row] = await scope.db
    .insert(apiKeys)
    .values({ ...input, accountId: scope.accountId })
    .onConflictDoUpdate({
      target: apiKeys.accountId,
      set: {
        key: input.key,
        secret: input.secret,
        last4: input.last4,
        label: input.label ?? null,
        // A rotated key must be re-verified: reset the prior outcome so the UI
        // does not show a stale 'ok'/'failed' for the new material. The save
        // path enqueues a fresh verify-key job that fills this in.
        verificationStatus: 'pending',
        verifiedAt: null,
        verificationError: null,
      },
    })
    .returning();
  if (!row) throw new Error('api-keys.upsert: insert returned no rows');
  return row;
}

/**
 * Record the verify-key outcome for the account's key. The worker calls this
 * after validating the key against Binance so a non-working key is no longer
 * silently indistinguishable from a working one. `error` is the Binance failure
 * message on `failed`, null on `ok`.
 */
export async function setVerification(
  scope: AccountScope,
  result: { status: 'ok' | 'failed'; error: string | null },
): Promise<void> {
  await scope.db
    .update(apiKeys)
    .set({
      verificationStatus: result.status,
      verifiedAt: new Date(),
      verificationError: result.error,
    })
    .where(eq(apiKeys.accountId, scope.accountId));
}

/**
 * Account-id-scoped read of the account's key row. Safe without an AccountScope
 * because `accountId` always arrives from an already-proven scope (the worker
 * holds a ProfileScope that joined this account). The worker resolves one key
 * pair per account this way — all profiles under an account share it.
 */
export async function findByAccountId(
  db: Database,
  accountId: AccountId,
): Promise<ApiKeyRow | null> {
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.accountId, accountId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Operator-scoped: the ids of the operator's accounts that have an api key
 * configured. One join for the account switcher's "keys set?" badge, avoiding an
 * N+1 over listForOwner. Database-first (not AccountScope) because it spans every
 * account the operator owns; the accounts join scopes it to the operator.
 */
export async function accountIdsWithKeyForOwner(
  db: Database,
  operatorId: UserId,
): Promise<AccountId[]> {
  const rows = await db
    .select({ accountId: apiKeys.accountId })
    .from(apiKeys)
    .innerJoin(accounts, eq(apiKeys.accountId, accounts.id))
    .where(eq(accounts.ownerId, operatorId));
  return rows.map((r) => r.accountId as AccountId);
}

/**
 * Delete the account's api key. Returns `true` if a row was removed, `false` if
 * there was nothing to delete (idempotent).
 */
export async function removeForAccount(scope: AccountScope): Promise<boolean> {
  const rows = await scope.db
    .delete(apiKeys)
    .where(eq(apiKeys.accountId, scope.accountId))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}
