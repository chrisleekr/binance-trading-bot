import { and, desc, eq, getTableColumns, gte, inArray, lte, sql } from 'drizzle-orm';
import { actionLogs, type ActionLogInsert, type ActionLogRow } from '../schema/action-logs.js';
import type { Database } from './_db.js';
import type { ProfileScope } from './_scoped.js';

/**
 * Composite cursor for {@link listPage}. The `id` tie-breaker covers rows that
 * share a `time` — without it a page boundary landing inside a same-timestamp
 * group leaves the rest of that group unreachable, and the drainer's bulk
 * inserts stamp whole batches within the same microsecond, so those groups are
 * the norm here rather than the exception.
 *
 * `time` is a microsecond-precision ISO string, not a `Date`: a JS `Date`
 * resolves only to milliseconds, so rows sharing a millisecond but differing in
 * the sub-ms digits would collapse to one cursor value and skip the row with the
 * smaller fraction. Each page row carries the full-resolution `cursorToken`;
 * bind it straight back.
 */
export interface ActionLogCursor {
  readonly time: string;
  readonly id: string;
}

/** Operator-supplied narrowing for {@link listPage} and the export reader. */
export interface ActionLogFilter {
  readonly from?: Date;
  readonly to?: Date;
  /** Empty means every level. */
  readonly levels?: readonly string[];
  /** Empty means every symbol. Profile-wide rows (null symbol) match only when empty. */
  readonly symbols?: readonly string[];
  /** Matches `ctx->>'source'`, e.g. 'tick' or 'entry-blocker'. */
  readonly source?: string;
  /** Case-insensitive substring of `msg`. */
  readonly q?: string;
}

const filterConditions = (scope: ProfileScope, filter: ActionLogFilter) => {
  const conditions = [eq(actionLogs.profileId, scope.profileId)];
  if (filter.from) conditions.push(gte(actionLogs.time, filter.from));
  if (filter.to) conditions.push(lte(actionLogs.time, filter.to));
  // An empty `inArray` renders as `IN ()`, which Postgres rejects, so an empty
  // list is omitted rather than passed — it already means "no narrowing".
  if (filter.levels && filter.levels.length > 0) {
    conditions.push(inArray(actionLogs.level, [...filter.levels]));
  }
  if (filter.symbols && filter.symbols.length > 0) {
    conditions.push(inArray(actionLogs.symbol, [...filter.symbols]));
  }
  if (filter.source) {
    conditions.push(sql`${actionLogs.ctx}->>'source' = ${filter.source}`);
  }
  if (filter.q) {
    // Escape the LIKE metacharacters so an operator pasting a Binance reason
    // containing `%` or `_` searches for those literal characters.
    const escaped = filter.q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    conditions.push(sql`${actionLogs.msg} ILIKE ${`%${escaped}%`}`);
  }
  return conditions;
};

/**
 * Keyset-paged profile log reader backing the Logs tab and the NDJSON export.
 * Newest-first on (time desc, id desc) so pages stay stable while the drainer
 * appends at the head. Each row carries the microsecond-precision `cursorToken`
 * that, paired with `id`, forms the next cursor.
 */
export async function listPage(
  scope: ProfileScope,
  limit: number,
  cursor: ActionLogCursor | null,
  filter: ActionLogFilter = {},
): Promise<(ActionLogRow & { cursorToken: string })[]> {
  const conditions = filterConditions(scope, filter);
  if (cursor !== null) {
    // Cast back to timestamptz so the comparison stays a direct column
    // predicate the (profile_id, time desc, id desc) index can serve.
    conditions.push(
      sql`(
        ${actionLogs.time} < ${cursor.time}::timestamptz
        OR (${actionLogs.time} = ${cursor.time}::timestamptz AND ${actionLogs.id} < ${cursor.id})
      )`,
    );
  }
  return scope.db
    .select({
      ...getTableColumns(actionLogs),
      cursorToken: sql<string>`to_char(${actionLogs.time} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(actionLogs)
    .where(and(...conditions))
    .orderBy(desc(actionLogs.time), desc(actionLogs.id))
    .limit(limit);
}

/**
 * Distinct symbols this profile has logged in the window, for the filter
 * control. Reads from the log table rather than the profile's configured
 * symbols so a symbol that has since been removed is still selectable while its
 * rows are within retention.
 */
export async function listLoggedSymbols(
  scope: ProfileScope,
  from: Date,
  to: Date,
): Promise<string[]> {
  const rows = await scope.db
    .selectDistinct({ symbol: actionLogs.symbol })
    .from(actionLogs)
    .where(
      and(
        eq(actionLogs.profileId, scope.profileId),
        gte(actionLogs.time, from),
        lte(actionLogs.time, to),
        sql`${actionLogs.symbol} is not null`,
      ),
    )
    .orderBy(actionLogs.symbol);
  return rows.map((r) => r.symbol).filter((s): s is string => s !== null);
}

export async function listRecent(scope: ProfileScope, limit: number): Promise<ActionLogRow[]> {
  return scope.db
    .select()
    .from(actionLogs)
    .where(eq(actionLogs.profileId, scope.profileId))
    .orderBy(desc(actionLogs.time))
    .limit(limit);
}

/**
 * Newest-first cap for {@link listForSymbolRange}. Its caller materialises every
 * row into one JSON response, which was fine when `action_logs` held only
 * actionable ticks. Deep capture writes a row per tick per symbol, so an
 * operator-chosen day-wide window is now tens of thousands of rows carrying full
 * audit payloads — enough to exhaust the box on a single request. The complete,
 * paged record lives on the Logs tab and its export; this reader is a recent tail.
 */
const SYMBOL_RANGE_MAX_ROWS = 2_000;

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
    .orderBy(desc(actionLogs.time))
    .limit(SYMBOL_RANGE_MAX_ROWS);
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
 * Newest-first tail of condition transitions, from every subsystem at once.
 *
 * This is the payoff of the uniform `ctx.source = 'condition'` envelope: one
 * filter yields every state change in the system in one shape, so the timeline
 * is a single query rather than a per-subsystem log grammar. Only edges are here
 * — a span still open is bounded by `condition_states.since`, which no retention
 * sweep touches, so a reader must combine the two rather than assume the oldest
 * edge in this window is where the span began.
 */
export async function listConditionEdges(
  scope: ProfileScope,
  limit: number,
): Promise<ActionLogRow[]> {
  return scope.db
    .select()
    .from(actionLogs)
    .where(
      and(
        eq(actionLogs.profileId, scope.profileId),
        sql`${actionLogs.ctx}->>'source' = 'condition'`,
      ),
    )
    .orderBy(desc(actionLogs.time))
    .limit(limit);
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
export async function insertMany(db: Database, rows: readonly ActionLogInsert[]): Promise<number> {
  if (rows.length === 0) return 0;
  const inserted = await db
    .insert(actionLogs)
    .values([...rows])
    .onConflictDoNothing({
      target: [actionLogs.profileId, actionLogs.time, actionLogs.id],
    })
    // The drainer needs the inserted-row count, not the UUID payload.
    .returning({ ok: sql<number>`1` });
  return inserted.length;
}

/**
 * What one age sweep did, in the two units it actually deletes in. Never summed:
 * a chunk is a whole hour of rows for every profile and a row is one row, so one
 * combined figure would report a night that dropped a day of history and a night
 * that deleted twelve stragglers as the same number.
 */
export interface ActionLogAgeSweep {
  /** Chunks dropped whole. Their rows are NOT counted — see {@link pruneOlderThan}. */
  readonly chunksDropped: number;
  /** Rows deleted individually from the one chunk that straddles the cutoff. */
  readonly rowsDeleted: number;
}

/**
 * Boundary-delete batch size. Bounds the transaction the straddling chunk's
 * delete opens, so a backlog cannot hold one lock long enough for BullMQ to call
 * the job stalled and re-run a sweep that was making progress.
 */
const BOUNDARY_DELETE_BATCH = 5_000;

/**
 * Global retention prune: nothing older than `cutoff` survives, across every
 * profile. Driven by the worker's `action-log-prune` cron.
 *
 * `action_logs` is a TimescaleDB hypertable chunked by time, so a horizon
 * measured in days always splits into whole chunks entirely past it plus exactly
 * one chunk straddling it. The two halves are deleted differently on purpose:
 *
 *  - `drop_chunks` unlinks the whole chunks. Catalogue work, not row work, so
 *    the cost does not grow with the backlog. A row-by-row DELETE over the same
 *    range scaled with the number of expired rows and is what put this cron in
 *    the DLQ as "job stalled more than allowable limit"; it also left the
 *    emptied chunks attached, to be re-scanned on every later run.
 *  - The straddling chunk is then swept row-by-row in bounded batches, because
 *    dropping it would take live rows with it.
 *
 * A dropped chunk's rows are deliberately NOT counted. Counting them means
 * reading them, which is the scan `drop_chunks` exists to avoid; the caller gets
 * both units and reports them as they are.
 *
 * Global, cross-tenant sweep run from the worker — takes `db` directly, not a
 * `ProfileScope`.
 *
 * `batchSize` is a parameter only so a test can drive the multi-batch path with
 * a handful of rows instead of seeding 5,001; production always takes the
 * default.
 */
export async function pruneOlderThan(
  db: Database,
  cutoff: Date,
  batchSize: number = BOUNDARY_DELETE_BATCH,
): Promise<ActionLogAgeSweep> {
  // `older_than` is a polymorphic `"any"` argument, so the bind needs an
  // explicit cast — an untyped parameter cannot be resolved by the planner.
  // The predicate is exclusive on the chunk's END, so a chunk holding even one
  // live row is left for the row-level pass below.
  const dropped = await db.execute(
    sql`select drop_chunks('action_logs', older_than => ${cutoff}::timestamptz)`,
  );

  let rowsDeleted = 0;
  for (;;) {
    // Keyed on `(time, id)` — the hypertable's own ordering — so each batch
    // seeks rather than scans, and no row is visited twice across batches.
    const batch = await db.execute(sql`
      delete from action_logs
      where (time, id) in (
        select time, id from action_logs
        where time < ${cutoff}
        order by time asc
        limit ${batchSize}
      )`);
    const deleted = batch.rowCount ?? 0;
    rowsDeleted += deleted;
    // A short batch means the range is exhausted. Also the loop's only exit, so
    // a driver reporting no count breaks out rather than spinning forever.
    if (deleted < batchSize) break;
  }

  return { chunksDropped: dropped.rowCount ?? 0, rowsDeleted };
}

/**
 * Trim one profile's action log to its newest `maxRows` rows.
 *
 * The bound is per profile, not table-wide, so a profile logging ten times as
 * much as the rest cannot evict a quiet profile's entire history under a shared
 * ceiling.
 *
 * Two statements rather than a window function over the table: the first reads
 * the boundary row by walking `action_logs_by_profile_time_id`
 * `(profile_id, time desc, id desc)` and stopping at the offset, and the second
 * deletes everything at or past it by the same key. Ranking every row of a
 * hypertable to find the same boundary would scan every chunk on every nightly
 * run. Returns the deleted-row count, reported separately from the age sweep.
 *
 * Global, cross-tenant sweep run from the worker — takes `db` directly, not a
 * `ProfileScope`.
 */
export async function pruneBeyondRowCap(
  db: Database,
  profileId: string,
  maxRows: number,
): Promise<number> {
  const [boundary] = await db
    .select({ time: actionLogs.time, id: actionLogs.id })
    .from(actionLogs)
    .where(eq(actionLogs.profileId, profileId))
    .orderBy(desc(actionLogs.time), desc(actionLogs.id))
    .offset(maxRows)
    .limit(1);
  // Fewer rows than the cap allows, so there is no boundary and nothing to do.
  if (!boundary) return 0;

  // No RETURNING: the count comes from the command tag, so the server never
  // builds, transfers, or buffers a result row per deleted row. A profile that
  // has run far past its cap is exactly when that materialisation is largest and
  // the sweep least able to afford it.
  const res = await db.delete(actionLogs).where(
    and(
      eq(actionLogs.profileId, profileId),
      // Row comparison against the same (time desc, id desc) key the index is
      // built on, so the delete seeks to the boundary instead of filtering.
      // Inclusive: the boundary row is itself the first row past the cap.
      sql`(${actionLogs.time}, ${actionLogs.id}) <= (${boundary.time}, ${boundary.id})`,
    ),
  );
  return res.rowCount ?? 0;
}
