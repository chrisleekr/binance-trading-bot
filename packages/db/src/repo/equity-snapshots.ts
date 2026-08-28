import { and, desc, eq, gte, lt, lte, ne, sql } from 'drizzle-orm';
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
 *
 * `quoteAsset` is required because the caller labels the whole series with ONE currency. A profile's quote can be changed, and rows recorded under the old one stay on disk (they were correct when written), so an unfiltered read hands the chart two currencies on one axis under the newer label. They are filtered out rather than deleted: the operator switching back makes that history readable again, and nothing is lost meanwhile.
 *
 * @param scope - Ownership-proven profile scope.
 * @param quoteAsset - The currency to read the series in, normally the profile's current one. Rows recorded under any other quote are omitted.
 * @param from - Inclusive lower bound on `captured_at`.
 * @param to - Inclusive upper bound on `captured_at`.
 * @param limit - Maximum rows; the NEWEST are kept when the range holds more.
 * @returns Complete matching rows, oldest-first for direct plotting. Empty when the profile has no trusted series in this quote.
 */
export async function listForProfileInRange(
  scope: ProfileScope,
  quoteAsset: string,
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
        // Every tier that HAS a basis, which is the set the boolean this column replaced admitted. Only `unknown` is a point with a charge missing, and excluding `estimated` too would empty the chart for any account Binance bills in BNB: a third-asset commission is reconstructed from the rate table on the forward path as much as on the backfill, so `exact` is not a bar the live path clears often enough to draw a line from.
        ne(equitySnapshots.feeBasis, 'unknown'),
        // Case-insensitive on BOTH sides, unlike the trade-archive filter: this column is stamped from the profile's own quote, which may be stored lower or mixed case, so neither the stored value nor the argument is guaranteed canonical.
        eq(sql`upper(${equitySnapshots.quoteAsset})`, quoteAsset.toUpperCase()),
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
