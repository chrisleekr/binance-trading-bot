import { and, eq } from 'drizzle-orm';
import { profileKv, type ProfileKvRow } from '../schema/profile-kv.js';
import type { ProfileScope } from './_scoped.js';

/**
 * Write a cross-symbol KV entry (tracker #267). Upsert on `(profileId, key)`:
 * the value is stored straight into jsonb, opaque to this layer. Concurrent
 * sibling ticks writing the same key are last-writer-wins.
 */
export async function upsert(scope: ProfileScope, key: string, value: unknown): Promise<void> {
  await scope.db
    .insert(profileKv)
    .values({ profileId: scope.profileId, key, value })
    .onConflictDoUpdate({
      target: [profileKv.profileId, profileKv.key],
      set: { value, updatedAt: new Date() },
    });
}

/** Delete a KV entry by key. Idempotent — a missing key is a no-op, not an error. */
export async function remove(scope: ProfileScope, key: string): Promise<void> {
  await scope.db
    .delete(profileKv)
    .where(and(eq(profileKv.profileId, scope.profileId), eq(profileKv.key, key)));
}

/** Every KV row for the profile — the worker folds these into one snapshot map. */
export async function listForProfile(scope: ProfileScope): Promise<ProfileKvRow[]> {
  return scope.db.select().from(profileKv).where(eq(profileKv.profileId, scope.profileId));
}

/**
 * The profile's KV store as a plain `{ key: value }` snapshot, the shape passed
 * to `TickInput.profileKv`. Empty object when the profile has no KV rows.
 */
export async function snapshotForProfile(scope: ProfileScope): Promise<Record<string, unknown>> {
  const rows = await listForProfile(scope);
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}
