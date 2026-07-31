import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// A Binance account under an operator: its own API key pair, one user-data
// stream, and one trading environment (`binance_mode`). Strategy profiles hang
// off an account (`profiles.account_id`), so profiles under one account share
// its keys, balances, and stream. The operator (`owner_id`) is the ownership
// anchor for the scope check; multi-login is out of scope (one operator).
//
// `binance_mode` lives here, not on profiles: a key pair belongs to exactly one
// environment (testnet keys are not mainnet keys), and keys are per-account, so
// the environment is an account attribute. To run both test and live the
// operator creates two accounts.
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    binanceMode: text('binance_mode').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Unique name per operator (switcher clarity). The leading `owner_id` also
    // serves the account switcher's list-by-owner read, so no separate owner
    // index is needed (Postgres does not auto-index the FK column).
    uniqueIndex('accounts_owner_name_uniq').on(table.ownerId, table.name),
    check('accounts_binance_mode_chk', sql`${table.binanceMode} in ('test','live')`),
  ],
);

export type AccountRow = typeof accounts.$inferSelect;
export type AccountInsert = typeof accounts.$inferInsert;
