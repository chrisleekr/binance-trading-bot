import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { profiles } from './profiles.js';

export const profileStateHistory = pgTable(
  'profile_state_history',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    strategyName: text('strategy_name').notNull(),
    strategyVersion: text('strategy_version').notNull(),
    state: jsonb('state').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('profile_state_history_profile_archived').on(table.profileId, table.archivedAt.desc()),
  ],
);

export type ProfileStateHistoryRow = typeof profileStateHistory.$inferSelect;
export type ProfileStateHistoryInsert = typeof profileStateHistory.$inferInsert;
