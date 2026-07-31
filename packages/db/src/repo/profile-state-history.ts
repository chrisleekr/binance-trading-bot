import { desc, eq } from 'drizzle-orm';
import {
  profileStateHistory,
  type ProfileStateHistoryInsert,
  type ProfileStateHistoryRow,
} from '../schema/profile-state-history.js';
import type { ProfileScope } from './_scoped.js';

export async function listForProfile(
  scope: ProfileScope,
  limit: number,
): Promise<ProfileStateHistoryRow[]> {
  return scope.db
    .select()
    .from(profileStateHistory)
    .where(eq(profileStateHistory.profileId, scope.profileId))
    .orderBy(desc(profileStateHistory.archivedAt))
    .limit(limit);
}

export async function archive(
  scope: ProfileScope,
  input: Omit<ProfileStateHistoryInsert, 'profileId'>,
): Promise<ProfileStateHistoryRow> {
  const [row] = await scope.db
    .insert(profileStateHistory)
    .values({ ...input, profileId: scope.profileId })
    .returning();
  if (!row) {
    throw new Error('profile-state-history.archive: insert returned no rows');
  }
  return row;
}
