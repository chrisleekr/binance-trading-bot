import { eq, sql } from 'drizzle-orm';
import { backupConfig, type BackupConfigRow } from '../schema/backup-config.js';
import type { Database } from './_db.js';

// Global singleton: backup is a whole-database dump, not account-scoped, so
// these are db-first with no userId / ProfileScope. The migration seeds the
// single `id = 1` row, so reads always find it.

const SINGLETON_ID = 1;

export async function get(db: Database): Promise<BackupConfigRow> {
  const rows = await db
    .select()
    .from(backupConfig)
    .where(eq(backupConfig.id, SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('backup-config.get: singleton row missing (migration not applied?)');
  return row;
}

export async function upsert(
  db: Database,
  input: { enabled: boolean; intervalHours: number; retentionCount: number },
): Promise<BackupConfigRow> {
  const [row] = await db
    .update(backupConfig)
    .set({
      enabled: input.enabled,
      intervalHours: input.intervalHours,
      retentionCount: input.retentionCount,
      updatedAt: sql`now()`,
    })
    .where(eq(backupConfig.id, SINGLETON_ID))
    .returning();
  if (!row) throw new Error('backup-config.upsert: singleton row missing (migration not applied?)');
  return row;
}

export async function touchLastBackup(db: Database, at: Date): Promise<void> {
  await db.update(backupConfig).set({ lastBackupAt: at }).where(eq(backupConfig.id, SINGLETON_ID));
}
