import {
  ManualOrderAllResponse,
  ProfileDashboardResponse,
  type ManualOrderAllRequest,
} from '@app/contracts';
import { z } from 'zod';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * The composite per-profile dashboard payload. Backed by Redis with a 5s TTL
 * server-side, so the route refetches at the same cadence to keep the symbols
 * grid fresh between WS frames.
 */
export const fetchProfileDashboard = (profileId: string): Promise<ProfileDashboardResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/dashboard`), ProfileDashboardResponse);

/**
 * Schedules a manual order on every enabled symbol of a profile. The API
 * returns `{ scheduled, firstFireAt, lastFireAt }` once the worker has
 * stamped the staggered fan-out — UI uses the count for the success banner.
 */
export const submitManualOrderAll = (
  profileId: string,
  body: ManualOrderAllRequest,
): Promise<ManualOrderAllResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/manual-order-all`), ManualOrderAllResponse, {
    method: 'POST',
    body,
  });

const NoBody = z.unknown();

/**
 * Engages the profile-wide kill-switch. The endpoint returns 204; we still
 * pipe through {@link apiFetch} so unauthenticated/permission errors share
 * the central handling.
 */
export const enableKillSwitch = (profileId: string): Promise<unknown> =>
  apiFetch(accountPath(`/profiles/${profileId}/disable-all`), NoBody, { method: 'POST' });

/** Releases the profile-wide kill-switch (mirror of {@link enableKillSwitch}). */
export const disableKillSwitch = (profileId: string): Promise<unknown> =>
  apiFetch(accountPath(`/profiles/${profileId}/disable-all`), NoBody, { method: 'DELETE' });

/**
 * Stable query key for the per-profile dashboard. Exported so route + WS
 * reducer write to the exact same cache slot — typo-driven cache misses
 * are the kind of bug that only shows up under live trading.
 */
export const profileDashboardQueryKey = (profileId: string) =>
  ['profile-dashboard', profileId] as const;
