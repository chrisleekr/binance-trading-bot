import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

// Durable memory of "we ran exactly this backtest and here is how it did", keyed
// by a full backtest signature (strategy + effective config + symbols + window +
// fill model). It SURVIVES deletion of the backtest_runs row it came from — there
// is NO `.references()` to it, and the SQL migration likewise declares no FK, so
// a run delete never reaches this table. That is the point: a re-run keeps
// avoiding a config it already proved a loser even after the operator clears the
// run history. `params`/`outcome`/`window` are validated where they are
// produced/consumed, so they are opaque jsonb here. Upserted on (profile_id,
// backtest_signature).
export const backtestResultLedger = pgTable(
  'backtest_result_ledger',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    // Full backtest identity from strategy-core backtestSignature().
    backtestSignature: text('backtest_signature').notNull(),
    // Strategy-config-only hash (configFingerprint), so the live gate can cross-ref.
    configFingerprint: text('config_fingerprint'),
    strategyId: text('strategy_id').notNull(),
    symbols: text('symbols').array().notNull(),
    window: jsonb('window').notNull(), // { fromMs, toMs, interval }
    params: jsonb('params').notNull(), // effective merged config the run executed
    outcome: jsonb('outcome').notNull(), // SUMMARY metrics only (no heavy series)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('backtest_result_ledger_sig_uq').on(table.profileId, table.backtestSignature),
    index('backtest_result_ledger_by_profile_strategy').on(table.profileId, table.strategyId),
  ],
);

export type BacktestResultLedgerRow = typeof backtestResultLedger.$inferSelect;
