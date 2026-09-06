import { EquitySnapshotsResponse } from '@app/contracts';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/**
 * The profile's net-P/L time series (oldest-first) for the profit-vs-hold curve.
 *
 * `window` bounds which instants come back. The server reduces a range holding more points than `limit` rather than clipping it, so a wide window costs a bounded response and still spans the whole period. Both edges belong in the caller's query key: two windows are two different series, and caching one under the other's key plots the wrong period.
 *
 * @param profileId - The profile whose series to read.
 * @param window - Optional ISO bounds; omitted means the server's default all-time window.
 * @returns The series, its quote asset and the profile's persisted benchmark mode.
 */
export const fetchEquitySnapshots = (profileId: string, window?: { from?: string; to?: string }) =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/equity-snapshots`),
    EquitySnapshotsResponse,
    {
      method: 'GET',
      query: { limit: 500, from: window?.from ?? null, to: window?.to ?? null },
    },
  );
