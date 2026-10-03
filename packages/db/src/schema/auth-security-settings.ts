import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, smallint, timestamp } from 'drizzle-orm/pg-core';

// Singleton (id = 1) holding the operator-tunable sign-in protection and the security epoch. `settings` is validated by @app/contracts AuthSecuritySettings on every read and write, never trusted as stored. See migration 0098.
export const authSecuritySettings = pgTable(
  'auth_security_settings',
  {
    id: smallint('id').primaryKey().default(1),
    settings: jsonb('settings')
      .notNull()
      .default(sql`'{}'::jsonb`),
    securityEpoch: integer('security_epoch').notNull().default(0),
    agentAccessNotBefore: timestamp('agent_access_not_before', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('auth_security_settings_id_check', sql`${table.id} = 1`)],
);

export type AuthSecuritySettingsRow = typeof authSecuritySettings.$inferSelect;
