import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { backtestRuns } from './backtest-runs.js';
import { profiles } from './profiles.js';

// A durable config-advisor result for one (profile, run, variant). Survives page
// reload and tab-close so the operator rehydrates saved suggestions without a
// re-billed model call, and doubles as the single-flight guard (a conditional
// upsert to `running` claims the slot). `suggestions`/`dropped` are validated at
// the API boundary against the @app/contracts advisor schemas, so they are
// opaque jsonb here. Cascade-deletes with its profile and its backtest run.
export const backtestAdvisorResult = pgTable(
  'backtest_advisor_result',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // The owning account. Stored for the multi-account data model; profile_id is
    // the isolation/query key, so account_id carries no FK or index (the profile
    // cascade reclaims a deleted account's rows).
    accountId: uuid('account_id').notNull(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => backtestRuns.id, { onDelete: 'cascade' }),
    variant: text('variant').notNull(),
    status: text('status').notNull(),
    summary: text('summary'),
    suggestions: jsonb('suggestions'),
    dropped: jsonb('dropped'),
    errorReason: text('error_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('backtest_advisor_result_status_chk', sql`${table.status} in ('running','done','error')`),
    check(
      'backtest_advisor_result_variant_chk',
      sql`${table.variant} in ('safe','ride-trend','trade-more','aggressive','defensive','manual')`,
    ),
    uniqueIndex('backtest_advisor_result_uq').on(table.profileId, table.runId, table.variant),
    index('backtest_advisor_result_run_idx').on(table.runId),
  ],
);

export type BacktestAdvisorResultRow = typeof backtestAdvisorResult.$inferSelect;
