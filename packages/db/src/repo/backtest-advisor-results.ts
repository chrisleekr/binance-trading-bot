import { and, asc, eq, lt, ne } from 'drizzle-orm';
import {
  backtestAdvisorResult,
  type BacktestAdvisorResultRow,
} from '../schema/backtest-advisor-result.js';
import type { Database } from './_db.js';
import type { ProfileScope } from './_scoped.js';

/**
 * Every persisted advisor variant for one run, oldest first. Feeds the list
 * route the UI rehydrates from so saved suggestions survive reload/tab-close.
 * Rows are opaque here (`suggestions`/`dropped` are jsonb); the API maps them to
 * the @app/contracts `AdvisorResult` shape at its boundary, same as backtest-runs.
 */
export async function listForRun(
  scope: ProfileScope,
  runId: string,
): Promise<BacktestAdvisorResultRow[]> {
  return scope.db
    .select()
    .from(backtestAdvisorResult)
    .where(
      and(
        eq(backtestAdvisorResult.profileId, scope.profileId),
        eq(backtestAdvisorResult.runId, runId),
      ),
    )
    .orderBy(asc(backtestAdvisorResult.createdAt));
}

/** A single (run, variant) advisor row for the scoped profile, or null. */
export async function getVariant(
  scope: ProfileScope,
  runId: string,
  variant: string,
): Promise<BacktestAdvisorResultRow | null> {
  const rows = await scope.db
    .select()
    .from(backtestAdvisorResult)
    .where(
      and(
        eq(backtestAdvisorResult.profileId, scope.profileId),
        eq(backtestAdvisorResult.runId, runId),
        eq(backtestAdvisorResult.variant, variant),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Claim a variant slot for background generation. Conditional upsert to
 * `running`: a brand-new row inserts, and a `done`/`error` row transitions back
 * (regenerate). A row already `running` is left untouched by the `setWhere`
 * guard, so RETURNING yields nothing. Returns whether the slot was claimed — the
 * caller enqueues a job IFF this is true, which is the single-flight guard (a
 * variant already in flight never spawns a duplicate job). Clears `error_reason`
 * on the transition so a re-run does not carry a stale failure. `account_id`
 * comes from the proven scope, not the caller, so the row's account always
 * matches.
 */
export async function transitionToRunning(
  scope: ProfileScope,
  input: { runId: string; variant: string },
): Promise<boolean> {
  const rows = await scope.db
    .insert(backtestAdvisorResult)
    .values({
      accountId: scope.accountId,
      profileId: scope.profileId,
      runId: input.runId,
      variant: input.variant,
      status: 'running',
    })
    .onConflictDoUpdate({
      target: [
        backtestAdvisorResult.profileId,
        backtestAdvisorResult.runId,
        backtestAdvisorResult.variant,
      ],
      set: { status: 'running', errorReason: null, updatedAt: new Date() },
      setWhere: ne(backtestAdvisorResult.status, 'running'),
    })
    .returning({ id: backtestAdvisorResult.id });
  return rows.length > 0;
}

/**
 * Write a variant's terminal state (`done` with suggestions, or `error` with a
 * reason). Scoped to the profile + run + variant unique key. `suggestions`/
 * `dropped` are opaque here (validated where produced); pass empty arrays on a
 * `done` run with no changes, and null `errorReason` unless `status` is `error`.
 */
export async function completeVariant(
  scope: ProfileScope,
  input: {
    runId: string;
    variant: string;
    status: 'done' | 'error';
    summary: string | null;
    suggestions: unknown;
    dropped: unknown;
    errorReason: string | null;
  },
): Promise<void> {
  await scope.db
    .update(backtestAdvisorResult)
    .set({
      status: input.status,
      summary: input.summary,
      suggestions: input.suggestions,
      dropped: input.dropped,
      errorReason: input.errorReason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(backtestAdvisorResult.profileId, scope.profileId),
        eq(backtestAdvisorResult.runId, input.runId),
        eq(backtestAdvisorResult.variant, input.variant),
      ),
    );
}

/**
 * Persist a `manual` variant result synchronously as `done`. The manual slot is
 * distinct from the server-generated variants, so this upsert never clobbers a
 * `safe` (or other) row for the same run. Used by the manual paste/parse route,
 * which parses a claude.ai reply client-side and has no background job.
 */
export async function upsertManual(
  scope: ProfileScope,
  input: { runId: string; summary: string | null; suggestions: unknown; dropped: unknown },
): Promise<void> {
  await scope.db
    .insert(backtestAdvisorResult)
    .values({
      accountId: scope.accountId,
      profileId: scope.profileId,
      runId: input.runId,
      variant: 'manual',
      status: 'done',
      summary: input.summary,
      suggestions: input.suggestions,
      dropped: input.dropped,
    })
    .onConflictDoUpdate({
      target: [
        backtestAdvisorResult.profileId,
        backtestAdvisorResult.runId,
        backtestAdvisorResult.variant,
      ],
      set: {
        status: 'done',
        summary: input.summary,
        suggestions: input.suggestions,
        dropped: input.dropped,
        errorReason: null,
        updatedAt: new Date(),
      },
    });
}

/**
 * GLOBAL maintenance sweep: mark every `running` advisor row last touched before
 * `olderThan` as `error` with reason `failed`, reclaiming a slot whose background
 * job was lost or died before writing a terminal state (else the UI polls a
 * `running` row forever). Run at study-worker boot across every profile, so it is
 * db-first like `backtest-studies.failStaleRunning`. Keys off `updated_at`, not
 * `created_at`: the row's age resets on the transition into `running`, so a
 * regenerated variant is timed from when its current job started. Returns the
 * count recovered.
 */
export async function failStaleRunning(db: Database, olderThan: Date): Promise<number> {
  const recovered = await db
    .update(backtestAdvisorResult)
    .set({ status: 'error', errorReason: 'failed', updatedAt: new Date() })
    .where(
      and(
        eq(backtestAdvisorResult.status, 'running'),
        lt(backtestAdvisorResult.updatedAt, olderThan),
      ),
    )
    .returning({ id: backtestAdvisorResult.id });
  return recovered.length;
}
