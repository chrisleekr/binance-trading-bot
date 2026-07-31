import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, timestamp } from 'drizzle-orm/pg-core';

/**
 * Global singleton holding the operator's scheduled-backup settings. Backup is a
 * whole-database dump, not per-user / per-profile, so exactly one row exists.
 * The `id = 1` CHECK plus a default of 1 make a second row impossible.
 *
 * The migration seeds the single row, so reads always find it and never have to
 * synthesise defaults.
 */
export const backupConfig = pgTable(
  'backup_config',
  {
    id: integer('id').primaryKey().default(1),
    enabled: boolean('enabled').notNull().default(false),
    intervalHours: integer('interval_hours').notNull().default(24),
    retentionCount: integer('retention_count').notNull().default(14),
    lastBackupAt: timestamp('last_backup_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('backup_config_singleton', sql`${table.id} = 1`)],
);

export type BackupConfigRow = typeof backupConfig.$inferSelect;
