import {
  and,
  count as countRows,
  desc,
  eq,
  getTableColumns,
  inArray,
  lt,
  ne,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import { backtestRuns, type BacktestRunRow } from '../schema/backtest-runs.js';
import type { Database } from './_db.js';
import type { ProfileScope } from './_scoped.js';

/**
 * Insert a queued run for the scoped profile and return the created row.
 */
export async function create(
  scope: ProfileScope,
  input: {
    symbols: readonly string[];
    params: unknown;
    // The run this one forked from (durable comparison lineage). Null/omitted for
    // a standalone run. The caller proves the parent is owned before passing it:
    // the FK only guarantees the id exists, not that it is in this account.
    parentRunId?: string | null;
  },
): Promise<BacktestRunRow> {
  const [row] = await scope.db
    .insert(backtestRuns)
    .values({
      profileId: scope.profileId,
      symbols: [...input.symbols],
      params: input.params,
      // Left null at insert. The signature is stamped by complete() from the
      // config that actually ran, not from POST-time config, so an edit in the
      // enqueue→pickup window cannot leave the row naming a config it never ran.
      backtestSignature: null,
      parentRunId: input.parentRunId ?? null,
      status: 'queued',
      progress: 0,
    })
    .returning();
  if (!row) throw new Error('backtest-runs.create: insert returned no rows');
  return row;
}

/**
 * The profile's most-recent COMPLETED run for a backtest signature, or null. The
 * create handler uses this to dedup an identical re-run: returning the existing
 * result instead of enqueuing a duplicate. Scoped to `done` runs with a stored
 * result (a finished, reusable outcome).
 */
export async function findDoneBySignature(
  scope: ProfileScope,
  signature: string,
): Promise<BacktestRunRow | null> {
  const rows = await scope.db
    .select()
    .from(backtestRuns)
    .where(
      and(
        eq(backtestRuns.profileId, scope.profileId),
        eq(backtestRuns.backtestSignature, signature),
        eq(backtestRuns.status, 'done'),
        sql`${backtestRuns.result} is not null`,
      ),
    )
    .orderBy(desc(backtestRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** A run by id, scoped to the profile (cross-account reads return null). */
export async function get(scope: ProfileScope, runId: string): Promise<BacktestRunRow | null> {
  const rows = await scope.db
    .select()
    .from(backtestRuns)
    .where(and(eq(backtestRuns.profileId, scope.profileId), eq(backtestRuns.id, runId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The profile's most recent `done` runs, newest first, capped at `limit`. The
 * live-enablement gate scans these for one whose `configFingerprint` matches the
 * profile's current config.
 */
export async function recentDone(scope: ProfileScope, limit: number): Promise<BacktestRunRow[]> {
  return scope.db
    .select()
    .from(backtestRuns)
    .where(and(eq(backtestRuns.profileId, scope.profileId), eq(backtestRuns.status, 'done')))
    .orderBy(desc(backtestRuns.createdAt))
    .limit(limit);
}

/**
 * Composite cursor for {@link list}. The `id` tie-breaker covers rows that
 * share a `createdAt` timestamp — without it, a page boundary that lands
 * inside a same-timestamp group leaves the remaining rows unreachable.
 *
 * `createdAt` is a microsecond-precision ISO string, not a `Date`: a JS `Date`
 * only resolves to milliseconds, so two rows sharing a millisecond but
 * differing in the sub-ms digits would collapse to one cursor value and skip
 * the row with the smaller fraction. The page row carries the full-resolution
 * token as `cursorToken`; bind it straight back.
 */
export interface BacktestRunCursor {
  readonly createdAt: string;
  readonly id: string;
}

/**
 * A page of runs for the profile, newest first. Cursor is composite
 * (`createdAt` + row `id`) so pages stay stable while new runs arrive at the
 * head of the table. The HTTP layer passes its own default page size; the `?? 20`
 * here only bounds no-arg internal callers. An optional `filter` narrows the
 * page (the runs-table filter): `error` by status, `profit`/`loss` by the done
 * run's total-return sign. It composes with the cursor so a filtered list
 * paginates correctly. `profit`/`loss` read `result->metrics->totalReturnPct`
 * (a JSON number; cast to float8), the same path the list route reads back.
 * Sign is strict: `profit` is `> 0`, `loss` is `< 0`, so a break-even done run
 * (exactly 0%, e.g. one the gates blocked into zero trades) matches neither and
 * shows only in the unfiltered list — it neither profited nor lost.
 *
 * Each row carries a `cursorToken`: the microsecond-precision `created_at`
 * rendered as an ISO string. The caller pairs it with the row `id` to form the
 * next-page cursor at full timestamp resolution.
 */
/**
 * The `profileId` + `filter` WHERE-conditions shared by {@link list} and
 * {@link count}, so the listed page and its total can never drift on a filter
 * change. The cursor predicate is list-only and appended by the caller.
 */
function runFilterConditions(
  scope: ProfileScope,
  opts?: {
    filter?: 'profit' | 'loss' | 'error' | undefined;
  },
): SQL[] {
  const conditions: SQL[] = [eq(backtestRuns.profileId, scope.profileId)];
  const returnPct = sql`(${backtestRuns.result} #>> '{metrics,totalReturnPct}')::float8`;
  if (opts?.filter === 'error') conditions.push(eq(backtestRuns.status, 'error'));
  else if (opts?.filter === 'profit')
    conditions.push(eq(backtestRuns.status, 'done'), sql`${returnPct} > 0`);
  else if (opts?.filter === 'loss')
    conditions.push(eq(backtestRuns.status, 'done'), sql`${returnPct} < 0`);
  return conditions;
}

export async function list(
  scope: ProfileScope,
  opts?: {
    limit?: number;
    cursor?: BacktestRunCursor | null;
    filter?: 'profit' | 'loss' | 'error' | undefined;
  },
): Promise<(BacktestRunRow & { cursorToken: string })[]> {
  const limit = opts?.limit ?? 20;
  const cursor = opts?.cursor ?? null;
  const conditions = runFilterConditions(scope, opts);
  if (cursor !== null) {
    // The cursor `createdAt` is cast back to timestamptz so the comparison
    // stays a direct column predicate (index-safe), not a string compare.
    conditions.push(
      sql`(
        ${backtestRuns.createdAt} < ${cursor.createdAt}::timestamptz
        OR (${backtestRuns.createdAt} = ${cursor.createdAt}::timestamptz AND ${backtestRuns.id} < ${cursor.id})
      )`,
    );
  }
  return scope.db
    .select({
      ...getTableColumns(backtestRuns),
      cursorToken: sql<string>`to_char(${backtestRuns.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    })
    .from(backtestRuns)
    .where(and(...conditions))
    .orderBy(desc(backtestRuns.createdAt), desc(backtestRuns.id))
    .limit(limit);
}

/**
 * Total runs for the scoped profile matching the same `filter`/`kind` as
 * {@link list} (ignoring the page cursor), so the past-runs UI can show an exact
 * count and derive a page count over cursor-based paging.
 */
export async function count(
  scope: ProfileScope,
  opts?: {
    filter?: 'profit' | 'loss' | 'error' | undefined;
  },
): Promise<number> {
  const [row] = await scope.db
    .select({ n: countRows() })
    .from(backtestRuns)
    .where(and(...runFilterConditions(scope, opts)));
  return row?.n ?? 0;
}

/**
 * Mark a not-yet-completed run as running and stamp its start time. Returns
 * whether the row transitioned. A `done` or `cancelled` run is left untouched
 * (returns false): `done` so a BullMQ retry firing after `complete()` cannot
 * resurrect a completed run into progress writes and a second `complete()`, and
 * `cancelled` so a job that is still queued when the run is aborted (the
 * operator's abort before it starts) is not flipped back to running and re-run.
 * An `error` row stays runnable on purpose:
 * that is exactly the path BullMQ's retry budget re-drives after a transient
 * engine/backfill failure, and a `running` row stays runnable so a retry after a
 * mid-run crash can resume.
 */
export async function markRunning(scope: ProfileScope, runId: string): Promise<boolean> {
  const rows = await scope.db
    .update(backtestRuns)
    .set({ status: 'running', startedAt: new Date() })
    .where(
      and(
        eq(backtestRuns.profileId, scope.profileId),
        eq(backtestRuns.id, runId),
        notInArray(backtestRuns.status, ['done', 'cancelled']),
      ),
    )
    .returning({ id: backtestRuns.id });
  return rows.length > 0;
}

/**
 * Update the 0-100 progress (and optional phase/count detail) of a running run.
 * Scoped to `status = 'running'` so a late, fire-and-forget write cannot land
 * after `complete`/`fail` and clobber the terminal progress (the worker
 * dispatches these un-awaited). `detail` is opaque jsonb here; the API validates
 * it against the contract's BacktestProgressDetailSchema.
 */
export async function updateProgress(
  scope: ProfileScope,
  runId: string,
  progress: number,
  detail?: unknown,
): Promise<void> {
  await scope.db
    .update(backtestRuns)
    .set(detail === undefined ? { progress } : { progress, progressDetail: detail })
    .where(
      and(
        eq(backtestRuns.profileId, scope.profileId),
        eq(backtestRuns.id, runId),
        eq(backtestRuns.status, 'running'),
      ),
    );
}

/**
 * Mark a run done with its result, progress 100, and finish time. Scoped to
 * `status = 'running'` so a run cancelled mid-flight (the operator aborted it in
 * the 2s poll gap before the engine happened to finish) is not resurrected to
 * 'done': completing the aborted run would defeat the cancel. Same status-guard
 * discipline as `updateProgress`.
 *
 * `backtestSignature` is the signature of the config that ACTUALLY ran (computed
 * by the worker at execution, not at enqueue). Stamped here so a later identical
 * re-run deduping via {@link findDoneBySignature} matches only rows whose stored
 * signature names the executed config. Written in the same atomic set as the
 * result under the `status = 'running'` guard, so a retry after `done` no-ops.
 */
export async function complete(
  scope: ProfileScope,
  runId: string,
  result: unknown,
  configFingerprint: string | null = null,
  backtestSignature: string | null = null,
): Promise<void> {
  await scope.db
    .update(backtestRuns)
    .set({
      status: 'done',
      result,
      progress: 100,
      finishedAt: new Date(),
      configFingerprint,
      backtestSignature,
    })
    .where(
      and(
        eq(backtestRuns.profileId, scope.profileId),
        eq(backtestRuns.id, runId),
        eq(backtestRuns.status, 'running'),
      ),
    );
}

/**
 * Mark a non-terminal run cancelled. The operator's abort endpoint calls this so
 * the worker — which polls this status mid-run — stops computing a result no
 * longer needed. Scoped to `queued`/`running` so a run that already reached a
 * terminal status (done/error/cancelled) is never clobbered. Returns whether a
 * row transitioned.
 */
export async function markCancelled(scope: ProfileScope, runId: string): Promise<boolean> {
  const rows = await scope.db
    .update(backtestRuns)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(
      and(
        eq(backtestRuns.profileId, scope.profileId),
        eq(backtestRuns.id, runId),
        inArray(backtestRuns.status, ['queued', 'running']),
      ),
    )
    .returning({ id: backtestRuns.id });
  return rows.length > 0;
}

/**
 * Delete a terminal run by id, scoped to the profile. Returns whether a row was
 * removed. Guarded to `done`/`error`/`cancelled` in the query itself so an
 * in-flight (`queued`/`running`) run is never deleted out from under its worker
 * job — that races a `complete()`/`fail()` write against a vanished row and
 * strands a queue slot; the caller 409s the operator to abort it first. A run
 * that is the profile's pinned baseline is refused upstream in the route (it is
 * referenced by other rows); this is the raw delete.
 */
export async function deleteById(scope: ProfileScope, runId: string): Promise<boolean> {
  const rows = await scope.db
    .delete(backtestRuns)
    .where(
      and(
        eq(backtestRuns.profileId, scope.profileId),
        eq(backtestRuns.id, runId),
        inArray(backtestRuns.status, ['done', 'error', 'cancelled']),
      ),
    )
    .returning({ id: backtestRuns.id });
  return rows.length > 0;
}

/** Mark a run errored with a message and finish time. */
export async function fail(scope: ProfileScope, runId: string, error: string): Promise<void> {
  await scope.db
    .update(backtestRuns)
    .set({ status: 'error', error, finishedAt: new Date() })
    .where(and(eq(backtestRuns.profileId, scope.profileId), eq(backtestRuns.id, runId)));
}

/**
 * GLOBAL recovery: mark one run errored by id alone. The backtest worker calls
 * this from its catch when the failure happened before the run was scoped (the
 * `profileRepo` ownership lookup or `markRunning` threw on a transient DB blip),
 * so no `ProfileScope` exists to prove. The runId came off a job the API had
 * already enqueued post-ownership-check, so re-proving ownership here is
 * unnecessary. Guards `status != 'done'` so a completed run is never clobbered.
 * Returns whether a row transitioned. Without this a pre-scope failure strands
 * the row `queued` forever (#363).
 */
export async function failById(db: Database, runId: string, error: string): Promise<boolean> {
  const rows = await db
    .update(backtestRuns)
    .set({ status: 'error', error, finishedAt: new Date() })
    .where(and(eq(backtestRuns.id, runId), ne(backtestRuns.status, 'done')))
    .returning({ id: backtestRuns.id });
  return rows.length > 0;
}

/**
 * GLOBAL cross-profile read: every run still `queued`/`running` and created
 * before `olderThan`. The periodic backtest-sweep cron reconciles each against
 * its BullMQ job and reclaims the ones with no live worker, so the age bound
 * here is only a small floor that skips a just-created run whose job has not
 * been enqueued yet — the cron, not the age, decides abandonment. db-first like
 * the other recovery sweeps.
 */
export async function listNonTerminalOlderThan(
  db: Database,
  olderThan: Date,
): Promise<{ id: string; profileId: string }[]> {
  return db
    .select({ id: backtestRuns.id, profileId: backtestRuns.profileId })
    .from(backtestRuns)
    .where(
      and(
        inArray(backtestRuns.status, ['queued', 'running']),
        lt(backtestRuns.createdAt, olderThan),
      ),
    );
}
