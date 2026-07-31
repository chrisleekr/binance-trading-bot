import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext } from './_types.js';

export const users = pgTable('users', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  email: citext('email').notNull().unique(),
  displayName: text('display_name'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
  // Operator display preference; account-global, applied to every rendered timestamp.
  timezone: text('timezone').notNull().default('UTC'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type UserInsert = typeof users.$inferInsert;
