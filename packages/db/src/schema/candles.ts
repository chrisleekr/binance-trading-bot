import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { numeric38_18 } from './_types.js';

// Global hypertable (no profile_id): candle OHLCV is exchange market data
// shared across all profiles. Money columns are read/written as decimal-
// strings via `numeric38_18` to keep IEEE-754 out of the price path.
// Closed candles are immutable, so backfill upserts with `do nothing`.
export const candles = pgTable(
  'candles',
  {
    symbol: text('symbol').notNull(),
    interval: text('interval').notNull(),
    openTime: timestamp('open_time', { withTimezone: true }).notNull(),
    open: numeric38_18('open').notNull(),
    high: numeric38_18('high').notNull(),
    low: numeric38_18('low').notNull(),
    close: numeric38_18('close').notNull(),
    volume: numeric38_18('volume').notNull(),
    closeTime: timestamp('close_time', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.symbol, table.interval, table.openTime] })],
);

export type CandleRow = typeof candles.$inferSelect;
export type CandleInsert = typeof candles.$inferInsert;
