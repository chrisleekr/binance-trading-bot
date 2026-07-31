import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

// `secrets` jsonb is isolated from `config` so projection rules in apps/api can
// drop it before serialising to the wire. Plaintext at rest by design (see 09).
export const profileNotifiers = pgTable(
  'profile_notifiers',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    config: jsonb('config').notNull(),
    secrets: jsonb('secrets')
      .notNull()
      .default(sql`'{}'::jsonb`),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // A profile owns at most one row per provider; the upsert path in the
    // repo depends on this constraint to make `INSERT ... ON CONFLICT
    // DO UPDATE` atomic against concurrent writes.
    profileProviderUq: uniqueIndex('profile_notifiers_profile_provider_uq').on(
      table.profileId,
      table.provider,
    ),
  }),
);

export type ProfileNotifierRow = typeof profileNotifiers.$inferSelect;
export type ProfileNotifierInsert = typeof profileNotifiers.$inferInsert;
