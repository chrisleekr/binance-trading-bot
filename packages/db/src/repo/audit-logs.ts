import type { UserId } from '@app/contracts';
import { and, asc, desc, eq, getTableColumns, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { auditLogs, type AuditLogInsert, type AuditLogRow } from '../schema/audit-logs.js';
import type { Database } from './_db.js';
import type { ProfileScope } from './_scoped.js';

/**
 * Composite cursor for {@link listForProfile}. The `id` tie-breaker covers
 * rows that share a `createdAt` timestamp — without it, a page boundary
 * that lands inside a same-timestamp group leaves the remaining rows of
 * that group unreachable on the next page.
 *
 * `createdAt` is a microsecond-precision ISO string, not a `Date`: a JS `Date`
 * only resolves to milliseconds, so two rows sharing a millisecond but
 * differing in the sub-ms digits would collapse to one cursor value and skip
 * the row with the smaller fraction. The page row carries the full-resolution
 * token as `cursorToken`; bind it straight back.
 */
export interface AuditLogCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * Paginated profile-scoped audit reader. Cursor is composite (`createdAt`
 * + row `id`) so pages stay stable while new rows arrive at the head of
 * the table.
 *
 * Each row carries a `cursorToken`: the microsecond-precision `created_at`
 * rendered as an ISO string, paired with the row `id` to form the next cursor.
 *
 * Filter: operator (the scope's operator) plus `payload->>'profileId' =
 * :profileId`. The audit middleware writes `profileId` into the payload for
 * every state-changing per-profile route; rows without a `profileId` are
 * operator-scoped events and intentionally excluded from this view.
 */
export async function listForProfile(
  scope: ProfileScope,
  limit: number,
  cursor: AuditLogCursor | null,
  events: readonly string[] = [],
): Promise<(AuditLogRow & { cursorToken: string })[]> {
  const conditions = [
    eq(auditLogs.operatorId, scope.operatorId),
    sql`${auditLogs.payload}->>'profileId' = ${scope.profileId}`,
  ];
  if (cursor !== null) {
    // The cursor `createdAt` is cast back to timestamptz so the comparison
    // stays a direct column predicate (index-safe), not a string compare.
    conditions.push(
      sql`(
        ${auditLogs.createdAt} < ${cursor.createdAt}::timestamptz
        OR (${auditLogs.createdAt} = ${cursor.createdAt}::timestamptz AND ${auditLogs.id} < ${cursor.id})
      )`,
    );
  }
  // Event whitelist (operator filter). Empty array means "all events".
  // An empty `inArray` is omitted rather than passed, since drizzle's
  // SQL builder emits `(IN ())` for an empty list which Postgres rejects.
  if (events.length > 0) {
    // Spread to a fresh mutable copy: drizzle's `inArray` signature is
    // `string[]`, not `readonly string[]`. Casting the readonly slice
    // would defeat the readonly guard at this call site.
    conditions.push(inArray(auditLogs.event, [...events]));
  }
  return scope.db
    .select({
      ...getTableColumns(auditLogs),
      cursorToken: sql<string>`to_char(${auditLogs.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit);
}

/**
 * Full profile-scoped audit history for the NDJSON export endpoint.
 *
 * Unbounded by design — no cursor. The result set is bounded instead by the
 * audit-log prune cron, so the full array stays small enough to materialise
 * and hand to the streaming export. Ascending by time so the downloaded file
 * reads oldest-first. Same operator + `payload->>'profileId'` filter as
 * {@link listForProfile} so the export matches the on-screen view.
 */
export async function listAllForProfile(
  scope: ProfileScope,
  from: Date,
  to: Date,
): Promise<AuditLogRow[]> {
  return scope.db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.operatorId, scope.operatorId),
        sql`${auditLogs.payload}->>'profileId' = ${scope.profileId}`,
        gte(auditLogs.createdAt, from),
        lte(auditLogs.createdAt, to),
      ),
    )
    .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id));
}

export async function append(
  db: Database,
  operatorId: UserId,
  input: Omit<AuditLogInsert, 'operatorId'>,
): Promise<AuditLogRow> {
  const [row] = await db
    .insert(auditLogs)
    .values({ ...input, operatorId })
    .returning();
  if (!row) throw new Error('audit-logs.append: insert returned no rows');
  return row;
}

/**
 * Per-operator prune. The worker's global retention cron uses
 * {@link pruneAllOlderThan} below. Returns the deleted-row count so callers can
 * log a useful retention receipt.
 */
export async function pruneOlderThan(
  db: Database,
  operatorId: UserId,
  cutoff: Date,
): Promise<number> {
  const rows = await db
    .delete(auditLogs)
    .where(and(eq(auditLogs.operatorId, operatorId), lt(auditLogs.createdAt, cutoff)))
    .returning({ ok: sql<number>`1` });
  return rows.length;
}

/**
 * Global, cross-operator prune. Driven by the worker's `audit-prune`
 * cron with a single retention-days horizon.
 */
export async function pruneAllOlderThan(db: Database, cutoff: Date): Promise<number> {
  const rows = await db
    .delete(auditLogs)
    .where(lt(auditLogs.createdAt, cutoff))
    .returning({ ok: sql<number>`1` });
  return rows.length;
}
