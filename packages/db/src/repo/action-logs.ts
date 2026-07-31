import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { actionLogs, type ActionLogInsert, type ActionLogRow } from '../schema/action-logs.js';
import type { Database } from './_db.js';
import type { ProfileScope } from './_scoped.js';

export async function listRecent(scope: ProfileScope, limit: number): Promise<ActionLogRow[]> {
  return scope.db
    .select()
    .from(actionLogs)
    .where(eq(actionLogs.profileId, scope.profileId))
    .orderBy(desc(actionLogs.time))
    .limit(limit);
}

export async function listForSymbolRange(
  scope: ProfileScope,
  symbol: string,
  from: Date,
  to: Date,
): Promise<ActionLogRow[]> {
  return scope.db
    .select()
    .from(actionLogs)
    .where(
      and(
        eq(actionLogs.profileId, scope.profileId),
        eq(actionLogs.symbol, symbol),
        gte(actionLogs.time, from),
        lte(actionLogs.time, to),
      ),
    )
    .orderBy(desc(actionLogs.time));
}

export async function listForProfileRange(
  scope: ProfileScope,
  from: Date,
  to: Date,
): Promise<ActionLogRow[]> {
  return scope.db
    .select()
    .from(actionLogs)
    .where(
      and(
        eq(actionLogs.profileId, scope.profileId),
        gte(actionLogs.time, from),
        lte(actionLogs.time, to),
      ),
    )
    .orderBy(desc(actionLogs.time));
}

/**
 * Bounded warn+error tail for the dashboard activity feed. Returns the most
 * recent rows whose `level` is 'warn' or 'error', newest-first, owner-scoped.
 * The feed merges these with audit and discovery rows, so a small `limit` is
 * the norm; there is no cursor.
 */
export async function listErrorsForProfile(
  scope: ProfileScope,
  limit: number,
): Promise<ActionLogRow[]> {
  return scope.db
    .select()
    .from(actionLogs)
    .where(
      and(eq(actionLogs.profileId, scope.profileId), inArray(actionLogs.level, ['warn', 'error'])),
    )
    .orderBy(desc(actionLogs.time))
    .limit(limit);
}

export async function append(
  scope: ProfileScope,
  input: Omit<ActionLogInsert, 'profileId'>,
): Promise<void> {
  await scope.db.insert(actionLogs).values({ ...input, profileId: scope.profileId });
}

/**
 * Bulk append already-attributed rows across profiles. Used by the worker's
 * audit drainer, which carries each row's `profileId` from the audit stream and
 * has no single `ProfileScope` to bind. Global, cross-tenant, trusted worker
 * path — mirrors `pruneOlderThan` in taking `db` directly. No-op on empty input
 * (an empty drain pass must never issue an `INSERT ... VALUES ()`).
 */
export async function insertMany(db: Database, rows: readonly ActionLogInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(actionLogs).values([...rows]);
}

/**
 * Global retention prune. Deletes every action_log row with
 * `time < cutoff` across all profiles. Driven by the worker's
 * `action-log-prune` cron with a single retention-days configuration.
 *
 * `action_logs` is a TimescaleDB hypertable, so the DELETE is
 * dispatched to the matching chunks by Timescale's planner; the
 * `RETURNING` clause is supported on hypertable deletes and gives a
 * useful deleted-row count for the cron's retention receipt log.
 *
 * Global, cross-tenant sweep run from the worker — takes `db` directly,
 * not a `ProfileScope`.
 */
export async function pruneOlderThan(db: Database, cutoff: Date): Promise<number> {
  // RETURNING a literal `1` rather than a real column so the result
  // wire payload is one byte per deleted row instead of a uuid; for a
  // daily retention sweep the row count drives the receipt log and
  // none of the column values are consumed.
  const rows = await db
    .delete(actionLogs)
    .where(lt(actionLogs.time, cutoff))
    .returning({ ok: sql<number>`1` });
  return rows.length;
}
