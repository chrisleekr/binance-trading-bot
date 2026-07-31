import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { numeric38_18 } from './_types.js';
import { profiles } from './profiles.js';

export const avgEntryPrices = pgTable(
  'avg_entry_prices',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    symbol: text('symbol').notNull(),
    avgEntryPrice: numeric38_18('avg_entry_price').notNull(),
    quantity: numeric38_18('quantity').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.symbol] })],
);

export type AvgEntryPriceRow = typeof avgEntryPrices.$inferSelect;
export type AvgEntryPriceInsert = typeof avgEntryPrices.$inferInsert;
