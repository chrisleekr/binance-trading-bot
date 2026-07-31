import { ProfileResponse, type ProfilePatch } from '@app/contracts';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * Read the bare profile row keyed by `profileId`.
 *
 * Returns the row as the API serialises it (strategy name + version, config
 * object, enabled flag, binance mode); the caller is responsible for any
 * derived projection (e.g. demo-badge logic in the dashboard route). The
 * `profileId` is path-encoded so a malformed id surfaces as a 404 instead of a
 * malformed URL.
 */
export const fetchProfile = (profileId: string): Promise<ProfileResponse> =>
  apiFetch(accountPath(`/profiles/${encodePathSegment(profileId)}`), ProfileResponse, {
    method: 'GET',
  });

/**
 * Patch fields on the profile row. The backend accepts a partial body — only
 * the keys present are updated — so this mirrors the shape and lets the caller
 * stage the patch before sending. Encoded path segment, see `fetchProfile`.
 */
export const patchProfile = (profileId: string, body: ProfilePatch): Promise<ProfileResponse> =>
  apiFetch(accountPath(`/profiles/${encodePathSegment(profileId)}`), ProfileResponse, {
    method: 'PATCH',
    body,
  });

/**
 * Query key for the bare profile row. Stability matters: React Query keys this
 * cache by reference equality of the array contents, so any caller that
 * builds the same `(profileId)` tuple shares the same cache entry.
 */
export const profileQueryKey = (profileId: string): readonly unknown[] => [
  'profile',
  'bare',
  profileId,
];
