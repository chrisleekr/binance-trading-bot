import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import {
  equitySnapshots,
  type EquitySnapshotPayload,
  type EquitySnapshotRow,
} from '../schema/equity-snapshots.js';
import type { Database } from './_db.js';
import type { ProfileScope } from './_scoped.js';

export async function record(
  scope: ProfileScope,
  payload: EquitySnapshotPayload,
): Promise<EquitySnapshotRow> {
  const [row] = await scope.db
    .insert(equitySnapshots)
    .values({ profileId: scope.profileId, ...payload })
    .returning();
  if (!row) {
    throw new Error('equity-snapshots.record: insert returned no rows');
  }
  return row;
}

/**
 * The profile's snapshots within `[from, to]`, oldest first so a chart can plot
 * the series directly. `limit` caps the row count (newest kept) for an unbounded
 * range; the result is still returned oldest-first.
 */
export async function listForProfileInRange(
  scope: ProfileScope,
  from: Date,
  to: Date,
  limit: number,
): Promise<EquitySnapshotRow[]> {
  const rows = await scope.db
    .select()
    .from(equitySnapshots)
    .where(
      and(
        eq(equitySnapshots.profileId, scope.profileId),
        gte(equitySnapshots.capturedAt, from),
        lte(equitySnapshots.capturedAt, to),
      ),
    )
    .orderBy(desc(equitySnapshots.capturedAt))
    .limit(limit);
  // Newest-first for the limit, then flipped to oldest-first for plotting.
  return rows.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
}

/**
 * Global retention prune. Deletes every equity_snapshots row with
 * `captured_at < cutoff` across all profiles, driven by the worker's
 * `equity-snapshot-prune` cron. Global, cross-tenant sweep — takes `db`
 * directly, not a `ProfileScope`. RETURNING a literal `1` per deleted row so the
 * count drives the cron log line; no column is read.
 */
export async function pruneOlderThan(db: Database, cutoff: Date): Promise<number> {
  const rows = await db
    .delete(equitySnapshots)
    .where(lt(equitySnapshots.capturedAt, cutoff))
    .returning({ ok: sql<number>`1` });
  return rows.length;
}
