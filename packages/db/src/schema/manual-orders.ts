import { sql } from 'drizzle-orm';
import { bigint, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

export const manualOrders = pgTable(
  'manual_orders',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    binanceOrderId: bigint('binance_order_id', { mode: 'bigint' }).notNull(),
    raw: jsonb('raw').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('manual_orders_profile_binance_uniq').on(table.profileId, table.binanceOrderId),
  ],
);

export type ManualOrderRow = typeof manualOrders.$inferSelect;
export type ManualOrderInsert = typeof manualOrders.$inferInsert;
