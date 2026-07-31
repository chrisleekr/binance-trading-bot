import {
  type ClosedTradesPeriod,
  DiscoveryDashboardResponse,
  DiscoveryScoreboardResponse,
  ProfileSymbolList,
  ProfileSymbolResponse,
  type StoredDiscoveryConfig,
  TriggerResponse,
} from '@app/contracts';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';
import { queryDefaults } from '@/shared/lib/query-client';

/** GET the discovery operator-dashboard payload (scoreboard + gauge + config + universe + activity). */
export const fetchDiscoveryDashboard = (profileId: string): Promise<DiscoveryDashboardResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/discovery`), DiscoveryDashboardResponse);

/**
 * GET the period-ranged discovery scoreboard (realised P/L, win rate, trades for
 * the selected D/W/M/All window). `tz` resolves the period boundaries against
 * the operator's local clock; it is stable per browser so it is not in the
 * cache key. Backs the Home KPI strip's toggle (#504).
 */
const fetchDiscoveryScoreboard = (
  profileId: string,
  period: ClosedTradesPeriod,
  tz: string,
): Promise<DiscoveryScoreboardResponse> => {
  const search = new URLSearchParams({ period, tz });
  return apiFetch(
    accountPath(`/profiles/${profileId}/discovery-scoreboard?${search.toString()}`),
    DiscoveryScoreboardResponse,
  );
};

/** Query options for the period-ranged discovery scoreboard; the period drives the cache key. */
export const discoveryScoreboardQueryOptions = (
  profileId: string,
  period: ClosedTradesPeriod,
  tz: string,
) => ({
  ...queryDefaults.discoveryScoreboard(profileId, period, tz),
  queryFn: () => fetchDiscoveryScoreboard(profileId, period, tz),
});

/** PATCH the profile's discovery config (pause, blocklist, threshold edits). */
export const patchDiscoveryConfig = (
  profileId: string,
  config: StoredDiscoveryConfig,
): Promise<DiscoveryDashboardResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/discovery-config`), DiscoveryDashboardResponse, {
    method: 'PATCH',
    body: config,
  });

/** Add a symbol to the discovery blacklist (idempotent) via the config PATCH. */
export const blocklistSymbol = (
  profileId: string,
  config: StoredDiscoveryConfig,
  symbol: string,
): Promise<DiscoveryDashboardResponse> =>
  patchDiscoveryConfig(profileId, {
    ...config,
    blacklist: config.blacklist.includes(symbol) ? config.blacklist : [...config.blacklist, symbol],
  });

/**
 * GET the profile's symbol roster (manual + auto bindings) with each row's
 * `source`. The discovery dashboard filters this to the `manual` ones to give
 * the operator's pinned coins a visible home — the auto rows already appear in
 * the live-universe list, and discovery_config holds no symbol list.
 */
const fetchProfileSymbols = (profileId: string): Promise<ProfileSymbolList> =>
  apiFetch(accountPath(`/profiles/${encodePathSegment(profileId)}/symbols`), ProfileSymbolList);

export const profileSymbolsQueryKey = (profileId: string) =>
  ['profile-symbols', profileId] as const;

/** Query options for the profile's symbol roster. */
export const profileSymbolsQueryOptions = (profileId: string) => ({
  queryKey: profileSymbolsQueryKey(profileId),
  queryFn: () => fetchProfileSymbols(profileId),
});

/** Pin an auto-discovered symbol to `manual` so discovery stops reaping it. */
export const pinSymbol = (profileId: string, symbol: string): Promise<ProfileSymbolResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/symbols/${symbol}/pin`), ProfileSymbolResponse, {
    method: 'POST',
  });

/** Return a manual symbol to discovery (`source='auto'`) — the inverse of pin. */
export const unpinSymbol = (profileId: string, symbol: string): Promise<ProfileSymbolResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/symbols/${symbol}/unpin`), ProfileSymbolResponse, {
    method: 'POST',
  });

/** Force-eject: sell the position to cash + engage cooldown; `blocklist` also blacklists it. */
export const forceEject = (
  profileId: string,
  symbol: string,
  blocklist: boolean,
): Promise<TriggerResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/symbols/${symbol}/force-eject`), TriggerResponse, {
    method: 'POST',
    body: { blocklist },
  });

export const discoveryDashboardQueryKey = (profileId: string) =>
  ['discovery-dashboard', profileId] as const;

/**
 * Query options for the discovery operator-dashboard. Polls at 10s — the cron
 * that updates the universe runs far slower, so this only keeps the scoreboard
 * and gauge reasonably fresh. Shared by the discovery dashboard and the home
 * scoped-KPI strip so both read one cache slot.
 */
export const discoveryDashboardQueryOptions = (profileId: string) => ({
  queryKey: discoveryDashboardQueryKey(profileId),
  queryFn: () => fetchDiscoveryDashboard(profileId),
  refetchInterval: 10_000,
});
