import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

// action_logs is a TimescaleDB hypertable. No PK is declared because TimescaleDB
// requires the partitioning column inside any PK and Postgres rejects nullable
// columns inside a PK (https://www.postgresql.org/docs/17/sql-createtable.html).
// Identity is instead the unique index on (profile_id, time, id).
//
// `id` exists so readers can page. A cursor on `time` alone skips or repeats
// rows whenever two share a timestamp, which the drainer's bulk inserts make
// routine rather than rare, so the sort and the cursor are both (time desc,
// id desc).
//
// `level` is one of 'debug' | 'info' | 'warn' | 'error' (string for forward-compat).
// 'debug' rows are written only while deep capture is armed.
export const actionLogs = pgTable(
  'action_logs',
  {
    time: timestamp('time', { withTimezone: true }).notNull(),
    id: uuid('id').notNull().defaultRandom(),
    profileId: uuid('profile_id').notNull(),
    symbol: text('symbol'),
    level: text('level').notNull(),
    msg: text('msg').notNull(),
    ctx: jsonb('ctx'),
  },
  (table) => [
    uniqueIndex('action_logs_by_profile_time_id').on(
      table.profileId,
      table.time.desc(),
      table.id.desc(),
    ),
    index('action_logs_by_profile_symbol_time_id').on(
      table.profileId,
      table.symbol,
      table.time.desc(),
      table.id.desc(),
    ),
    index('action_logs_by_profile_level_time_id').on(
      table.profileId,
      table.level,
      table.time.desc(),
      table.id.desc(),
    ),
  ],
);

export type ActionLogRow = typeof actionLogs.$inferSelect;
export type ActionLogInsert = typeof actionLogs.$inferInsert;
