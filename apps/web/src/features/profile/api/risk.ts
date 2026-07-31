import { RiskDashboardResponse, type StoredRiskConfig } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/** Query key for a profile's risk config + breaker status. */
export const riskDashboardQueryKey = (profileId: string) => ['risk', profileId] as const;

/** GET the risk config + live circuit-breaker status. */
const fetchRiskDashboard = (profileId: string): Promise<RiskDashboardResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/risk`), RiskDashboardResponse);

/**
 * Query options for the risk card. Polls every 5s so the "entries paused" state
 * and today's realised P/L stay current while the card is open (mirrors the
 * market-trend card's poll cadence).
 */
export const riskDashboardQueryOptions = (profileId: string) => ({
  queryKey: riskDashboardQueryKey(profileId),
  queryFn: () => fetchRiskDashboard(profileId),
  refetchInterval: 5_000,
});

/** PATCH the profile's risk config (the daily-loss limit). */
export const patchRiskConfig = (
  profileId: string,
  config: StoredRiskConfig,
): Promise<RiskDashboardResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/risk-config`), RiskDashboardResponse, {
    method: 'PATCH',
    body: config,
  });
