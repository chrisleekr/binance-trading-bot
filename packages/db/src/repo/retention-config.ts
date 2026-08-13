import { eq, sql } from 'drizzle-orm';
import { retentionConfig, type RetentionConfigRow } from '../schema/retention-config.js';
import type { Database } from './_db.js';

// Global singleton: retention is a whole-database concern, not account-scoped,
// so these are db-first with no ProfileScope. The migration seeds the single
// `id = 1` row, so reads always find it.

const SINGLETON_ID = 1;

export async function get(db: Database): Promise<RetentionConfigRow> {
  const rows = await db
    .select()
    .from(retentionConfig)
    .where(eq(retentionConfig.id, SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('retention-config.get: singleton row missing (migration not applied?)');
  return row;
}

/**
 * Patch the singleton. Every field is optional so the UI can move one knob
 * without restating the rest, and so arming deep capture does not have to
 * round-trip the retention numbers.
 */
export async function update(
  db: Database,
  input: {
    actionLogDays?: number;
    actionLogMaxRows?: number;
    auditLogDays?: number;
    auditStreamMaxlen?: number;
    debugCaptureProfileId?: string | null;
    debugCaptureUntil?: Date | null;
  },
): Promise<RetentionConfigRow> {
  const [row] = await db
    .update(retentionConfig)
    .set({
      ...(input.actionLogDays !== undefined ? { actionLogDays: input.actionLogDays } : {}),
      ...(input.actionLogMaxRows !== undefined ? { actionLogMaxRows: input.actionLogMaxRows } : {}),
      ...(input.auditLogDays !== undefined ? { auditLogDays: input.auditLogDays } : {}),
      ...(input.auditStreamMaxlen !== undefined
        ? { auditStreamMaxlen: input.auditStreamMaxlen }
        : {}),
      ...(input.debugCaptureProfileId !== undefined
        ? { debugCaptureProfileId: input.debugCaptureProfileId }
        : {}),
      ...(input.debugCaptureUntil !== undefined
        ? { debugCaptureUntil: input.debugCaptureUntil }
        : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(retentionConfig.id, SINGLETON_ID))
    .returning();
  if (!row) {
    throw new Error('retention-config.update: singleton row missing (migration not applied?)');
  }
  return row;
}
