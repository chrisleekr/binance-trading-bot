import { EquitySnapshotsResponse } from '@app/contracts';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/** The profile's net-P/L time series (oldest-first) for the profit-vs-hold card. */
export const fetchEquitySnapshots = (profileId: string) =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/equity-snapshots`),
    EquitySnapshotsResponse,
    { method: 'GET', query: { limit: 500 } },
  );
