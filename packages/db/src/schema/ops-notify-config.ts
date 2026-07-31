import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, timestamp } from 'drizzle-orm/pg-core';

// Account-global ops notification config, a singleton (id = 1) mirroring
// backup_config. `events` holds the per-category toggle map (validated by
// @app/contracts OpsNotifyConfig at the boundary, not the DB); empty = the
// contract defaults (every ops category on).
export const opsNotifyConfig = pgTable(
  'ops_notify_config',
  {
    id: integer('id').primaryKey().default(1),
    events: jsonb('events')
      .notNull()
      .default(sql`'{}'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [check('ops_notify_config_singleton', sql`${table.id} = 1`)],
);

export type OpsNotifyConfigRow = typeof opsNotifyConfig.$inferSelect;
