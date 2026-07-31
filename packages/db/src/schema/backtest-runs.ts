import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

// Allowed run statuses. The DB stays a leaf (no @app/contracts import), so
// this set is duplicated from the contract's `BacktestStatus`; a parity test
// (`__tests__/backtest-runs-status-parity.test.ts`) fails if the two drift.
export const BACKTEST_RUN_STATUSES = ['queued', 'running', 'done', 'error', 'cancelled'] as const;

// A backtest run for a profile. The durable source of truth for status and
// result: a run survives worker restarts and reconnects where the WS progress
// stream's replay window has rolled past. `params`/`result` are validated at
// the API boundary against the @app/contracts schemas, so they are opaque
// jsonb here.
export const backtestRuns = pgTable(
  'backtest_runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    symbols: text('symbols').array().notNull(),
    params: jsonb('params').notNull(),
    status: text('status').notNull(),
    progress: integer('progress').notNull().default(0),
    // Phase/count context for the live-progress UI (validated against
    // @app/contracts BacktestProgressDetailSchema at the API boundary, opaque
    // jsonb here). Null until the worker writes the first progress detail.
    progressDetail: jsonb('progress_detail'),
    result: jsonb('result'),
    error: text('error'),
    // Fingerprint of the EFFECTIVE merged strategy config this run executed
    // (profile config + run override), stamped by the worker on completion. The
    // live-enablement gate matches it against the profile's current config so a
    // backtest counts as proof only for the config it actually tested. Null for
    // runs that completed before this column shipped (they never match → re-run).
    configFingerprint: text('config_fingerprint'),
    // Full backtest signature (strategy + effective config + market + fill model)
    // stamped by the worker at COMPLETION (create writes null). The create
    // handler recomputes the signature and matches it against the profile's
    // completed standalone runs to dedup an identical re-run instead of enqueuing
    // a duplicate. Null while a run is in flight, and for runs created before this
    // column shipped (they never match → a normal run).
    backtestSignature: text('backtest_signature'),
    // The run a Re-run forked from (the anchored run whose config the Draft was
    // launched against), for durable comparison lineage. Self-referential FK with
    // ON DELETE SET NULL: deleting the parent clears the pointer rather than
    // cascade-deleting the child. Null for a standalone run with no anchor. The
    // self-reference needs an AnyPgColumn return annotation to break TS's circular
    // inference; there is no module import cycle (same table).
    parentRunId: uuid('parent_run_id').references((): AnyPgColumn => backtestRuns.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    check(
      'backtest_runs_status_chk',
      sql`${table.status} in ('queued','running','done','error','cancelled')`,
    ),
    check('backtest_runs_progress_chk', sql`${table.progress} between 0 and 100`),
    index('backtest_runs_by_profile_created').on(table.profileId, table.createdAt.desc()),
    index('backtest_runs_by_profile_signature').on(table.profileId, table.backtestSignature),
  ],
);

export type BacktestRunRow = typeof backtestRuns.$inferSelect;
