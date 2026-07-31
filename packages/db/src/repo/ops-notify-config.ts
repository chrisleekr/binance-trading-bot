import { eq, sql } from 'drizzle-orm';
import { opsNotifyConfig, type OpsNotifyConfigRow } from '../schema/ops-notify-config.js';
import type { Database } from './_db.js';

// Global singleton: account-level ops notification toggles, not account-scoped,
// so these are db-first with no userId / ProfileScope. The migration seeds the
// single `id = 1` row, so reads always find it.

const SINGLETON_ID = 1;

export async function get(db: Database): Promise<OpsNotifyConfigRow> {
  const rows = await db
    .select()
    .from(opsNotifyConfig)
    .where(eq(opsNotifyConfig.id, SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('ops-notify-config.get: singleton row missing');
  return row;
}

export async function setEvents(db: Database, events: unknown): Promise<OpsNotifyConfigRow> {
  const [row] = await db
    .update(opsNotifyConfig)
    .set({ events, updatedAt: sql`now()` })
    .where(eq(opsNotifyConfig.id, SINGLETON_ID))
    .returning();
  if (!row) throw new Error('ops-notify-config.setEvents: singleton row missing');
  return row;
}
