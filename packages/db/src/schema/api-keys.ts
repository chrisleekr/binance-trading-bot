import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts.js';

// 1 account : 1 Binance API key pair (enforced by unique(account_id)). Profiles
// under the account share this key pair. Plaintext storage is intentional; see
// docs/architecture/auth.md "Threat model". Operator must IP-allowlist keys at
// the Binance console.
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    label: text('label'),
    key: text('key').notNull(),
    secret: text('secret').notNull(),
    last4: text('last4').notNull(),
    // Verify-key outcome, persisted so a non-working key is distinguishable from
    // a working one. 'pending' until the first verify-key run; the repo resets
    // it to 'pending' whenever the key material changes.
    verificationStatus: text('verification_status').notNull().default('pending'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verificationError: text('verification_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('api_keys_account_uniq').on(table.accountId)],
);

export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type ApiKeyInsert = typeof apiKeys.$inferInsert;
