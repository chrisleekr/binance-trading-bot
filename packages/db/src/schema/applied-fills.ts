import { bigint, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

// PG-side dedupe ledger for fill-adopter. See migrations/0016_applied_fills.sql
// for the why; in short, the Redis SADD that previously dedupe'd fills was
// released on mid-mutation failure so retries could proceed, but that meant
// the LBP weighted-average upsert could be replayed against the already-
// updated row, double-counting the same fill quantity. This table is the
// commit-durable marker; a `RETURNING`-empty insert identifies a replay.
export const appliedFills = pgTable(
  'applied_fills',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    orderId: bigint('order_id', { mode: 'number' }).notNull(),
    tradeId: bigint('trade_id', { mode: 'number' }).notNull(),
    side: text('side', { enum: ['BUY', 'SELL'] }).notNull(),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.symbol, table.orderId, table.tradeId] }),
  ],
);
