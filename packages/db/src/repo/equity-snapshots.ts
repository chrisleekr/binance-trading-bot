import { and, desc, eq, getTableColumns, gte, lt, lte, sql } from 'drizzle-orm';
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
 * The profile's snapshots within `[from, to]`, oldest first so a chart can plot the series directly, reduced server-side to at most `limit` points.
 *
 * `limit` is a POINT CAP, not a row cap, and the difference is the whole reason this is not a `LIMIT`. The cron writes a snapshot every 15 minutes, so any window worth charting outgrows a fixed cap, and taking the newest `limit` rows off the top does not shorten the series, it CLIPS it: the chart silently starts partway through the period and the operator reads a curve that begins at whatever value the bot happened to hold that day. Under the cap the read is unchanged and every row is returned. Over it, the range is cut into `limit` equal buckets and the LAST snapshot in each is kept, so the curve keeps its span, its shape and its final value, and every point is a real observation rather than a synthesised average.
 *
 * Bucket width comes from the span of the MATCHED ROWS, never from the requested range: the all-time read asks for `[epoch, now]`, whose span is decades, and a width derived from that would collapse a year of trading into a handful of points.
 *
 * `quoteAsset` is required because the caller labels the whole series with ONE currency. A profile's quote can be changed, and rows recorded under the old one stay on disk (they were correct when written), so an unfiltered read hands the chart two currencies on one axis under the newer label. They are filtered out rather than deleted: the operator switching back makes that history readable again, and nothing is lost meanwhile.
 *
 * Deliberately NOT filtered by `feeBasis`. A snapshot's realised leg is an ALL-TIME cumulative fold, so its tier is the weakest any cycle the profile ever closed carries, and closing further cycles can only weaken it. One path lifts a tier at all — the operator-triggered fee reconciliation — and it repairs archive rows, never the snapshots already stamped from them, so no snapshot's tier ever improves once written. Withholding `unknown` here therefore does not defer a point until better evidence arrives, it blanks the whole curve permanently for any account that has one historical cycle Binance billed in an asset nobody valued. The tier travels with each row instead, so the decision to mark or withhold is made where the line is drawn.
 *
 * @param scope - Ownership-proven profile scope.
 * @param quoteAsset - The currency to read the series in, normally the profile's current one. Rows recorded under any other quote are omitted.
 * @param from - Inclusive lower bound on `captured_at`.
 * @param to - Inclusive upper bound on `captured_at`.
 * @param limit - Maximum POINTS to return. A range holding more is downsampled to it, never truncated.
 * @returns At most `limit` rows, oldest-first for direct plotting, each a real snapshot carrying its own `feeBasis`. Empty only when the profile has no series in this quote.
 */
export async function listForProfileInRange(
  scope: ProfileScope,
  quoteAsset: string,
  from: Date,
  to: Date,
  limit: number,
): Promise<EquitySnapshotRow[]> {
  const where = and(
    eq(equitySnapshots.profileId, scope.profileId),
    // Case-insensitive on BOTH sides, unlike the trade-archive filter: this column is stamped from the profile's own quote, which may be stored lower or mixed case, so neither the stored value nor the argument is guaranteed canonical.
    eq(sql`upper(${equitySnapshots.quoteAsset})`, quoteAsset.toUpperCase()),
    gte(equitySnapshots.capturedAt, from),
    lte(equitySnapshots.capturedAt, to),
  );

  // What the window actually holds, before deciding whether it needs reducing. One cheap aggregate over the same predicate, so the decision and the read cannot disagree about which rows are in scope.
  const [extent] = await scope.db
    .select({
      points: sql<number>`count(*)::int`,
      spanSeconds: sql<number>`coalesce(extract(epoch from (max(${equitySnapshots.capturedAt}) - min(${equitySnapshots.capturedAt}))), 0)::int`,
    })
    .from(equitySnapshots)
    .where(where);

  if (extent === undefined || extent.points <= limit) {
    return scope.db.select().from(equitySnapshots).where(where).orderBy(equitySnapshots.capturedAt);
  }

  // Ceiling division against `limit - 1` intervals, so bucket alignment to the epoch cannot push the count past `limit`: with a width of at least span/(limit-1), the window spans at most limit-1 boundaries and therefore at most `limit` buckets. Floored at one second because two snapshots can share a second and a zero-width bucket is an error, not an empty result.
  const widthSeconds = Math.max(1, Math.ceil(extent.spanSeconds / Math.max(1, limit - 1)));
  // The width is INLINED, not bound. Postgres requires the DISTINCT ON expressions to match the leading ORDER BY expressions, and it compares them after parsing — where `$1` and `$6` are two different parameters even when the driver binds both to the same number. Emitting the width twice as a bind therefore fails the statement outright rather than mis-sorting quietly. Safe to inline because the value is an integer this function computed with `Math.ceil`, never operator input.
  const width = sql.raw(String(Math.trunc(widthSeconds)));
  const bucket = sql`time_bucket(make_interval(secs => ${width}), ${equitySnapshots.capturedAt})`;
  // DISTINCT ON keeps one WHOLE row per bucket rather than aggregating the columns apart: an averaged point would pair a P/L with a benchmark price that never stood beside it, and the fee tier, which is a claim about one row's evidence, has no average at all. The last snapshot in each bucket is the state the period actually ended each interval in, which is what a cumulative curve plots.
  const reduced = await scope.db
    .selectDistinctOn([bucket], getTableColumns(equitySnapshots))
    .from(equitySnapshots)
    .where(where)
    .orderBy(bucket, desc(equitySnapshots.capturedAt));
  // The bucket arithmetic above bounds the count for every limit but one. At `limit = 1` the divisor collapses to 1, the width becomes the whole span, and `time_bucket` aligns to the epoch rather than to the first row — so the two endpoints can fall either side of a boundary and come back as two rows against a cap of one. Trimming here rather than widening the bucket, because a wider bucket would move every OTHER limit's points to fix the one that is wrong.
  // Trimmed off the FRONT: the rows arrive oldest bucket first, and dropping from the end would discard the newest point, which is the one the doc above promises the curve keeps and the only one a single-point read can mean.
  return reduced.slice(Math.max(0, reduced.length - limit));
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
