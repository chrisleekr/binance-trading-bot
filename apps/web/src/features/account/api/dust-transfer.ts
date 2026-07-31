// Dust-transfer queries. The list endpoint returns Binance's eligible-asset set
// for one profile; the POST schedules an override action so the actual Binance
// call happens off the request thread (a slow Binance API can't time out the
// operator's click).

import {
  DustConversionHistory,
  DustTransferList,
  DustTransferResponse,
  type DustTransferRequest,
} from '@app/contracts';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * Fetch the eligible-dust set for one profile.
 *
 * The list is Binance-derived, computed by the API from cached balance + the
 * dust threshold; it's never empty when the account has positions but is
 * frequently empty for a fresh testnet profile. The frontend treats `[]` as a
 * valid "nothing to convert" state, not an error. `profileId` is path-encoded
 * so a malformed id 404s rather than producing a malformed URL.
 */
export const fetchDustList = (profileId: string): Promise<DustTransferList> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/dust-transfer`),
    DustTransferList,
    {
      method: 'GET',
    },
  );

/**
 * Schedule a dust-to-BNB conversion override for one profile.
 *
 * Returns the API's acknowledgement immediately; the actual Binance call
 * happens off the request thread so a slow upstream can't time out the
 * operator's click. The route shows the queued state and refetches the list
 * on success — a freshly converted asset is no longer in the eligible set.
 */
export const submitDustTransfer = (
  profileId: string,
  body: DustTransferRequest,
): Promise<DustTransferResponse> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/dust-transfer`),
    DustTransferResponse,
    {
      method: 'POST',
      body,
    },
  );

/**
 * Fetch the profile's past dust conversions, most recent first. Any money-path
 * action is recorded, so this is the durable operator history — each row shows
 * what was requested, what actually converted, and the BNB received.
 */
export const fetchDustHistory = (profileId: string): Promise<DustConversionHistory> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/dust-transfer/history`),
    DustConversionHistory,
    { method: 'GET' },
  );
