import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// action_logs is a TimescaleDB hypertable; no PK is declared because TimescaleDB
// requires the partitioning column inside any PK and Postgres rejects nullable
// columns inside a PK (https://www.postgresql.org/docs/17/sql-createtable.html).
// We accept duplicate-tolerant append-only telemetry.
//
// `level` is one of 'debug' | 'info' | 'warn' | 'error' (string for forward-compat).
export const actionLogs = pgTable(
  'action_logs',
  {
    time: timestamp('time', { withTimezone: true }).notNull(),
    profileId: uuid('profile_id').notNull(),
    symbol: text('symbol'),
    level: text('level').notNull(),
    msg: text('msg').notNull(),
    ctx: jsonb('ctx'),
  },
  (table) => [
    index('action_logs_by_profile_time').on(table.profileId, table.time.desc()),
    index('action_logs_by_profile_symbol_time').on(
      table.profileId,
      table.symbol,
      table.time.desc(),
    ),
  ],
);

export type ActionLogRow = typeof actionLogs.$inferSelect;
export type ActionLogInsert = typeof actionLogs.$inferInsert;
