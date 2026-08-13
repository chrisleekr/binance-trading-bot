import { sql } from 'drizzle-orm';
import { check, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Global singleton holding how long logs are kept and how much per-tick trace is
 * captured. Retention is a whole-database concern, not per-account, so exactly
 * one row exists; the `id = 1` CHECK plus a default of 1 make a second row
 * impossible and the migration seeds it so reads never synthesise defaults.
 *
 * This row is the single owner of the retention horizon. It replaced the pair of
 * worker env vars and the TimescaleDB retention policy that both used to delete
 * from `action_logs` on different schedules, which let the table be swept days
 * earlier than the dashboard reported.
 */
export const retentionConfig = pgTable(
  'retention_config',
  {
    id: integer('id').primaryKey().default(1),
    actionLogDays: integer('action_log_days').notNull().default(1),
    /**
     * Newest rows kept per profile, enforced alongside the age horizon. Per
     * profile rather than table-wide: one noisy profile under a shared cap
     * evicts every quiet profile's history, which is the opposite of what a
     * bound on growth is for.
     */
    actionLogMaxRows: integer('action_log_max_rows').notNull().default(200_000),
    auditLogDays: integer('audit_log_days').notNull().default(90),
    /**
     * Redis stream trim length, applied by the tick's `XADD ... MAXLEN ~`. Bounds
     * how far back the raw per-tick trace reaches and, with it, how long the
     * drainer can be down before unpersisted entries are trimmed away.
     */
    auditStreamMaxlen: integer('audit_stream_maxlen').notNull().default(100_000),
    /** Profile whose every tick is persisted at full fidelity. Null = capture off. */
    debugCaptureProfileId: uuid('debug_capture_profile_id'),
    /** When deep capture lapses. Past or null = off; nothing has to disarm it. */
    debugCaptureUntil: timestamp('debug_capture_until', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Names match what the migration's inline `check (...)` clauses make Postgres
  // generate, so a constraint-violation error read off a live database points
  // back at these lines. The migration is the source of truth; `db:generate` is
  // not used in this repo, so these labels are documentation only.
  (table) => [
    check('retention_config_id_check', sql`${table.id} = 1`),
    check('retention_config_action_log_days_check', sql`${table.actionLogDays} between 1 and 365`),
    check('retention_config_audit_log_days_check', sql`${table.auditLogDays} between 1 and 365`),
    check(
      'retention_config_action_log_max_rows_check',
      sql`${table.actionLogMaxRows} between 1000 and 10000000`,
    ),
    check(
      'retention_config_audit_stream_maxlen_check',
      sql`${table.auditStreamMaxlen} between 1000 and 5000000`,
    ),
  ],
);

export type RetentionConfigRow = typeof retentionConfig.$inferSelect;
