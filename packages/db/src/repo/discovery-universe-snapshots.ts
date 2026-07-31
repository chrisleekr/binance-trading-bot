import { desc, eq, lt, sql } from 'drizzle-orm';
import {
  discoveryUniverseSnapshots,
  type DiscoveryUniverseSnapshotPayload,
  type DiscoveryUniverseSnapshotRow,
} from '../schema/discovery-universe-snapshots.js';
import type { Database } from './_db.js';
import type { ProfileScope } from './_scoped.js';

export async function record(
  scope: ProfileScope,
  snapshot: DiscoveryUniverseSnapshotPayload,
): Promise<DiscoveryUniverseSnapshotRow> {
  const [row] = await scope.db
    .insert(discoveryUniverseSnapshots)
    .values({ profileId: scope.profileId, snapshot })
    .returning();
  if (!row) {
    throw new Error('discovery-universe-snapshots.record: insert returned no rows');
  }
  return row;
}

export async function listForProfile(
  scope: ProfileScope,
  limit: number,
): Promise<DiscoveryUniverseSnapshotRow[]> {
  return scope.db
    .select()
    .from(discoveryUniverseSnapshots)
    .where(eq(discoveryUniverseSnapshots.profileId, scope.profileId))
    .orderBy(desc(discoveryUniverseSnapshots.capturedAt))
    .limit(limit);
}

/**
 * Global retention prune. Deletes every discovery_universe_snapshots row with
 * `captured_at < cutoff` across all profiles, driven by the worker's
 * `discovery-snapshot-prune` cron. Retention is intentionally generous (the
 * series is MEANT to accumulate for a backtest window).
 *
 * Global, cross-tenant sweep run from the worker — takes `db` directly, not a
 * `ProfileScope`. RETURNING a literal `1` so the result payload is one byte per
 * deleted row; the count drives the cron's log line, none of the columns are read.
 */
export async function pruneOlderThan(db: Database, cutoff: Date): Promise<number> {
  const rows = await db
    .delete(discoveryUniverseSnapshots)
    .where(lt(discoveryUniverseSnapshots.capturedAt, cutoff))
    .returning({ ok: sql<number>`1` });
  return rows.length;
}
