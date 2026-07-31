import type { AccountId, UserId } from '@app/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { accounts, type AccountInsert, type AccountRow } from '../schema/accounts.js';
import type { Database } from './_db.js';
import type { AccountScope } from './_scoped.js';

// Operator-scoped (Database first): the operator owns the create/list surface.
// These do not take an AccountScope because the account does not yet exist
// (create) or is being enumerated (list).

/** Create an account owned by the operator. Unique (owner_id, name) is enforced by the DB. */
export async function create(
  db: Database,
  operatorId: UserId,
  input: Omit<AccountInsert, 'ownerId'>,
): Promise<AccountRow> {
  const [row] = await db
    .insert(accounts)
    .values({ ...input, ownerId: operatorId })
    .returning();
  if (!row) throw new Error('accounts.create: insert returned no rows');
  return row;
}

/**
 * Account-id-scoped read of just the environment. Safe without an AccountScope
 * because `accountId` always arrives from an already-proven scope (a ProfileScope
 * that joined this account, or an AccountScope). The API fills ProfileResponse's
 * account-level `binanceMode` from this; the worker resolves the environment for
 * an account's key pair from it too.
 */
export async function binanceModeById(
  db: Database,
  accountId: AccountId,
): Promise<'test' | 'live' | null> {
  const [row] = await db
    .select({ binanceMode: accounts.binanceMode })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return (row?.binanceMode as 'test' | 'live') ?? null;
}

/**
 * True if any account (across every operator) is on the live Binance
 * environment. Deployment-wide, not operator-scoped: it backs the `LIVE_DEMO`
 * boot guard, which must refuse to start a demo box that holds a live key pair.
 */
export async function anyLiveMode(db: Database): Promise<boolean> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.binanceMode, 'live'))
    .limit(1);
  return rows.length > 0;
}

/** Every account owned by the operator, oldest first (the account switcher's source). */
export async function listForOwner(db: Database, operatorId: UserId): Promise<AccountRow[]> {
  return db
    .select()
    .from(accounts)
    .where(eq(accounts.ownerId, operatorId))
    .orderBy(asc(accounts.createdAt), asc(accounts.id));
}

// Account-scoped (AccountScope first): ownership already proven by scopeAccount.
// The redundant owner_id filter is belt-and-suspenders, matching the scoped-repo
// style elsewhere.

/** The scoped account row, or null if it was deleted after the scope was resolved. */
export async function get(scope: AccountScope): Promise<AccountRow | null> {
  const [row] = await scope.db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, scope.accountId), eq(accounts.ownerId, scope.operatorId)))
    .limit(1);
  return row ?? null;
}

/** Update name and/or binance_mode. Returns the updated row, or null if gone. */
export async function update(
  scope: AccountScope,
  patch: Partial<Pick<AccountInsert, 'name' | 'binanceMode'>>,
): Promise<AccountRow | null> {
  const [row] = await scope.db
    .update(accounts)
    .set(patch)
    .where(and(eq(accounts.id, scope.accountId), eq(accounts.ownerId, scope.operatorId)))
    .returning();
  return row ?? null;
}

/** Delete the account (cascades to its profiles, keys, and their children). */
export async function deleteById(scope: AccountScope): Promise<boolean> {
  const rows = await scope.db
    .delete(accounts)
    .where(and(eq(accounts.id, scope.accountId), eq(accounts.ownerId, scope.operatorId)))
    .returning({ id: accounts.id });
  return rows.length > 0;
}
