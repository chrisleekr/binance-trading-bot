import { GateStatusResponse } from '@app/contracts';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/** Query key for a profile's live-gate status. Module-private: only the query
 * options below key off it; no external consumer invalidates by this key. */
const gateStatusQueryKey = (profileId: string) => ['gate-status', profileId] as const;

/** GET the live-gate status (config-validated / entries-paused / gate-off). */
const fetchGateStatus = (profileId: string): Promise<GateStatusResponse> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/gate-status`),
    GateStatusResponse,
  );

/**
 * Query options for the gate-status card. Polls every 30s — the status moves
 * slowly (the enforcer cron re-checks every 15 min), so a slow poll keeps the
 * "entries paused" state fresh without being chatty.
 */
export const gateStatusQueryOptions = (profileId: string) => ({
  queryKey: gateStatusQueryKey(profileId),
  queryFn: () => fetchGateStatus(profileId),
  refetchInterval: 30_000,
});
