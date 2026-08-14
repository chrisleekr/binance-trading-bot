import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { DiagnosisStep, ProfileDiagnosis } from '@app/contracts';
import { profiles } from './profiles.js';

/**
 * One "why isn't it trading?" investigation. Durable because the run is watched
 * rather than awaited: the operator can close the dialog, reload, or come back
 * later and must find the same run in the same state.
 */
export const diagnosisRuns = pgTable(
  'diagnosis_runs',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    status: text('status').notNull().$type<'queued' | 'running' | 'done' | 'error'>(),
    /** Per-step progress, rewritten as each check lands. */
    steps: jsonb('steps').notNull().$type<readonly DiagnosisStep[]>().default([]),
    /** The assembled report; null until the run finishes. */
    report: jsonb('report').$type<ProfileDiagnosis>(),
    /** Operator-facing failure reason; null unless `status` is `error`. */
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  // Descending to match the hand-authored migration, which is what actually runs.
  (table) => [
    index('diagnosis_runs_by_profile_started').on(table.profileId, table.startedAt.desc()),
  ],
);

export type DiagnosisRunRow = typeof diagnosisRuns.$inferSelect;
