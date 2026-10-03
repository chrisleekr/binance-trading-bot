import { eq, sql } from 'drizzle-orm';
import {
  authSecuritySettings,
  type AuthSecuritySettingsRow,
} from '../schema/auth-security-settings.js';
import type { Database } from './_db.js';

// Global singleton: sign-in protection is deployment-wide, not account-scoped. Migration 0098 seeds the id = 1 row, so reads always find it.

const SINGLETON_ID = 1;

/**
 * Reads the stored settings document and the current security epoch.
 *
 * @param db - Database handle.
 * @returns The raw row; `settings` is unvalidated jsonb the caller must parse against the contract before trusting.
 */
export async function get(db: Database): Promise<AuthSecuritySettingsRow> {
  const rows = await db
    .select()
    .from(authSecuritySettings)
    .where(eq(authSecuritySettings.id, SINGLETON_ID))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('auth-security-settings.get: singleton row missing');
  return row;
}

/**
 * Replaces the settings document. The caller validates it first; this function stores whatever it is given.
 *
 * @param db - Database handle.
 * @param settings - The already-validated settings document.
 * @returns The updated row.
 */
export async function setSettings(
  db: Database,
  settings: unknown,
): Promise<AuthSecuritySettingsRow> {
  const [row] = await db
    .update(authSecuritySettings)
    .set({ settings, updatedAt: sql`now()` })
    .where(eq(authSecuritySettings.id, SINGLETON_ID))
    .returning();
  if (!row) throw new Error('auth-security-settings.setSettings: singleton row missing');
  return row;
}

/**
 * Advances the security epoch, which invalidates every session and known-device cookie issued before it in one write.
 *
 * @param db - Database handle, or a transaction so the bump commits together with the change that caused it.
 * @param atLeast - An epoch the result must exceed even if the stored one is lower. A restore brings back the dump's older epoch; bumping only that would re-validate known-device cookies revoked after the dump was taken.
 * @returns The new epoch.
 */
export async function bumpSecurityEpoch(db: Database, atLeast = 0): Promise<number> {
  const [row] = await db
    .update(authSecuritySettings)
    .set({
      securityEpoch: sql`greatest(${authSecuritySettings.securityEpoch}, ${atLeast}) + 1`,
      updatedAt: sql`now()`,
    })
    .where(eq(authSecuritySettings.id, SINGLETON_ID))
    .returning({ securityEpoch: authSecuritySettings.securityEpoch });
  if (!row) throw new Error('auth-security-settings.bumpSecurityEpoch: singleton row missing');
  return row.securityEpoch;
}
