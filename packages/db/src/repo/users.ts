import type { UserId } from '@app/contracts';
import { eq, sql } from 'drizzle-orm';
import { users, type UserInsert, type UserRow } from '../schema/users.js';
import type { Database } from './_db.js';

export async function count(db: Database): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  return rows[0]?.count ?? 0;
}

/**
 * The sole operator's id, or null before onboarding. There is exactly one
 * `users` row forever (sign-up 403s once one exists), so `limit(1)` is total.
 * Used to resolve the demo-operator identity injected under `LIVE_DEMO`.
 */
export async function findSingleId(db: Database): Promise<UserId | null> {
  const rows = await db.select({ id: users.id }).from(users).limit(1);
  return (rows[0]?.id as UserId | undefined) ?? null;
}

export async function findById(db: Database, userId: UserId): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Looks up a user by login email for operator recovery flows (`bun reset-
 * password`). Returns `null` instead of throwing so callers can map absence
 * to deterministic CLI exit codes.
 */
export async function findByEmail(db: Database, email: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}

export async function insert(
  db: Database,
  userId: UserId,
  input: Omit<UserInsert, 'id'>,
): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({ ...input, id: userId })
    .returning();
  if (!row) throw new Error('users.insert: insert returned no rows');
  return row;
}

export async function update(
  db: Database,
  userId: UserId,
  fields: Partial<Pick<UserInsert, 'timezone'>>,
): Promise<UserRow> {
  const [row] = await db.update(users).set(fields).where(eq(users.id, userId)).returning();
  if (!row) throw new Error('users.update: update returned no rows');
  return row;
}
