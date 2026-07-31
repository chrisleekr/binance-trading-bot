import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// Regular Postgres table (NOT a hypertable) — row volume is bounded by
// daily prune, not by time-bucket partitioning.
//
// Privacy: ip and user_agent are stored plain because v1.0 runs single-user
// and these fields are needed for forensic debugging of operator actions.
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // The operator who acted (not an account). Audit is operator-scoped: it
    // records who did what, and a profile-scoped read still filters on the
    // operator, so this stays keyed to `users.id` while other tables move to
    // `account_id`.
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    actor: text('actor').notNull(),
    event: text('event').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_by_operator_recent').on(table.operatorId, table.createdAt.desc()),
    // Serves the profile-scoped reads that filter on the payload->>'profileId'
    // expression; the trailing (created_at desc, id desc) covers their ORDER BY
    // + keyset cursor.
    index('audit_logs_by_operator_profile_recent').on(
      table.operatorId,
      sql`(${table.payload}->>'profileId')`,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
);

export type AuditLogRow = typeof auditLogs.$inferSelect;
export type AuditLogInsert = typeof auditLogs.$inferInsert;
