import { and, desc, eq, inArray, lt, notInArray } from 'drizzle-orm';
import type { DiagnosisStep, ProfileDiagnosis } from '@app/contracts';
import { diagnosisRuns, type DiagnosisRunRow } from '../schema/diagnosis-runs.js';
import type { Database } from './_db.js';
import type { ProfileScope } from './_scoped.js';

/**
 * Every read and write is scoped to the profile, so a run id belonging to
 * another account's profile simply does not resolve. Ownership is proven by the
 * scope, not by comparing ids in the route — a check that gets forgotten is a
 * cross-account leak, and there is nothing to forget here.
 */

/** Seed a run as `queued` before the job is enqueued, so a poll never 404s on a live run. */
export async function create(
  scope: ProfileScope,
  input: { readonly id: string; readonly steps: readonly DiagnosisStep[]; readonly now: Date },
): Promise<DiagnosisRunRow> {
  const rows = await scope.db
    .insert(diagnosisRuns)
    .values({
      id: input.id,
      profileId: scope.profileId,
      status: 'queued',
      steps: input.steps,
      startedAt: input.now,
    })
    .returning();
  return rows[0] as DiagnosisRunRow;
}

export async function findById(
  scope: ProfileScope,
  runId: string,
): Promise<DiagnosisRunRow | undefined> {
  const rows = await scope.db
    .select()
    .from(diagnosisRuns)
    .where(and(eq(diagnosisRuns.profileId, scope.profileId), eq(diagnosisRuns.id, runId)))
    .limit(1);
  return rows[0];
}

export async function listForProfile(
  scope: ProfileScope,
  limit: number,
): Promise<DiagnosisRunRow[]> {
  return scope.db
    .select()
    .from(diagnosisRuns)
    .where(eq(diagnosisRuns.profileId, scope.profileId))
    .orderBy(desc(diagnosisRuns.startedAt))
    .limit(limit);
}

/**
 * Publish the ladder's current position. Called after each rung, which is what
 * makes the progress the UI shows the worker's real state.
 *
 * Non-terminal rows only. A run that outlives the sweep cutoff is reclaimed as
 * `error` while its job is still alive; without the guard the next rung writes
 * `running` back over it, leaving a live-looking row that also carries a
 * finish time and a failure the operator was already shown.
 */
export async function patchSteps(
  scope: ProfileScope,
  runId: string,
  steps: readonly DiagnosisStep[],
): Promise<void> {
  await scope.db
    .update(diagnosisRuns)
    .set({ status: 'running', steps })
    .where(
      and(
        eq(diagnosisRuns.profileId, scope.profileId),
        eq(diagnosisRuns.id, runId),
        inArray(diagnosisRuns.status, ['queued', 'running']),
      ),
    );
}

/**
 * Record the finished report. Clears `error` because a run reclaimed by the
 * sweep and then completed anyway is a success, and the drawer renders that
 * string verbatim next to the result.
 */
export async function finish(
  scope: ProfileScope,
  runId: string,
  report: ProfileDiagnosis,
  now: Date,
): Promise<void> {
  await scope.db
    .update(diagnosisRuns)
    .set({ status: 'done', steps: report.steps, report, error: null, finishedAt: now })
    .where(and(eq(diagnosisRuns.profileId, scope.profileId), eq(diagnosisRuns.id, runId)));
}

export async function fail(
  scope: ProfileScope,
  runId: string,
  error: string,
  now: Date,
): Promise<void> {
  await scope.db
    .update(diagnosisRuns)
    .set({ status: 'error', error, finishedAt: now })
    .where(and(eq(diagnosisRuns.profileId, scope.profileId), eq(diagnosisRuns.id, runId)));
}

/**
 * GLOBAL maintenance sweep: mark every `queued` or `running` run started before
 * `olderThan` as `error`, reclaiming a row whose job was lost or died before any
 * terminal write. Returns the count recovered.
 *
 * Without it such a row is stranded permanently: the queue runs with
 * `attempts: 1`, so nothing retries it, the client polls a live run forever, and
 * the drawer keeps "Check again" hidden because a run is still in flight. The
 * feature becomes unusable for that profile with no operator-side recovery.
 *
 * Keys off `started_at` rather than an updated stamp: a run is created once and
 * never restarts, so its start IS the age of its job.
 */
export async function failStaleNonTerminal(db: Database, olderThan: Date): Promise<number> {
  const recovered = await db
    .update(diagnosisRuns)
    .set({
      status: 'error',
      // Operator-facing, like every other terminal reason on this row: it is
      // rendered verbatim in the drawer.
      error: 'The investigation stopped unexpectedly. Run it again.',
      finishedAt: new Date(),
    })
    .where(
      and(
        inArray(diagnosisRuns.status, ['queued', 'running']),
        lt(diagnosisRuns.startedAt, olderThan),
      ),
    )
    .returning({ id: diagnosisRuns.id });
  return recovered.length;
}

/**
 * Keep the newest `keep` runs for this profile and drop the rest. Per profile,
 * never table-wide: a table-wide cap would let one heavily-investigated profile
 * evict another's history.
 */
export async function pruneKeepNewest(scope: ProfileScope, keep: number): Promise<number> {
  const survivors = await scope.db
    .select({ id: diagnosisRuns.id })
    .from(diagnosisRuns)
    .where(eq(diagnosisRuns.profileId, scope.profileId))
    .orderBy(desc(diagnosisRuns.startedAt))
    .limit(keep);
  const keepIds = survivors.map((r) => r.id);
  const deleted = await scope.db
    .delete(diagnosisRuns)
    .where(
      keepIds.length === 0
        ? eq(diagnosisRuns.profileId, scope.profileId)
        : and(eq(diagnosisRuns.profileId, scope.profileId), notInArray(diagnosisRuns.id, keepIds)),
    )
    .returning({ id: diagnosisRuns.id });
  return deleted.length;
}
