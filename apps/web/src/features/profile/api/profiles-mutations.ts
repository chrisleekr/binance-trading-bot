import { ProfileResponse, type ProfileCreate, type ProfilePatch } from '@app/contracts';
import { z } from 'zod';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/** `apiFetch` parses a 204 as `schema.safeParse(undefined)`; `z.unknown()` accepts `undefined`. */
const NoBody = z.unknown();

/**
 * Create a profile via `POST /profiles`. Server re-validates the strategy
 * config against the registered plugin schema, so the client can stay loose
 * about the `config` shape; a server 422 surfaces the strategy-specific
 * complaint.
 */
export const createProfile = (body: ProfileCreate): Promise<ProfileResponse> =>
  apiFetch(accountPath('/profiles'), ProfileResponse, { method: 'POST', body });

/**
 * Enable a profile — `POST /profiles/:id/start` (204). Sets `enabled` and
 * enqueues the `subscribe-profile` pipeline job so the worker starts ticking.
 */
export const startProfile = (profileId: string): Promise<unknown> =>
  apiFetch(accountPath(`/profiles/${profileId}/start`), NoBody, { method: 'POST' });

/** Disable a profile — `POST /profiles/:id/stop` (204). The inverse of {@link startProfile}. */
export const stopProfile = (profileId: string): Promise<unknown> =>
  apiFetch(accountPath(`/profiles/${profileId}/stop`), NoBody, { method: 'POST' });

/**
 * Enqueue `POST /profiles/:id/reconcile-fees` so the worker retries incomplete Binance fee evidence. Rows remain unavailable when the required historical valuation cannot be proven.
 *
 * @param profileId - Profile whose incomplete archive rows should be retried.
 * @returns The completed API request after the reconciliation job is accepted.
 */
export const reconcileProfileFees = (profileId: string): Promise<unknown> =>
  apiFetch(accountPath(`/profiles/${profileId}/reconcile-fees`), NoBody, { method: 'POST' });

/** Patch a profile via `PATCH /profiles/:id`; used by the detail-page rename affordance. */
export const patchProfile = (profileId: string, body: ProfilePatch): Promise<ProfileResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}`), ProfileResponse, { method: 'PATCH', body });

/**
 * Deletes the profile. A profile with live exposure cannot simply be deleted: the
 * api answers 409 with the open counts, and the caller must pick a `disposition`
 * — `cancel-orders` (the worker cancels the resting orders on Binance) or
 * `handoff` (the position moves to `toProfileId`). Either way the api enqueues the
 * disposal (202) and the WORKER removes the row once Binance is provably clear.
 */
export const deleteProfile = (
  profileId: string,
  disposition?: 'cancel-orders' | 'handoff',
  toProfileId?: string,
): Promise<unknown> =>
  apiFetch(accountPath(`/profiles/${profileId}`), NoBody, {
    method: 'DELETE',
    query: { disposition, toProfileId },
  });
