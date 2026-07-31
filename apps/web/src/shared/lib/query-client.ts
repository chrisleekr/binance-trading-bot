import { MutationCache, QueryClient, type QueryClientConfig } from '@tanstack/react-query';

import { ApiError } from '@/shared/lib/api';

const FIVE_MINUTES_MS = 1000 * 60 * 5;
const THIRTY_MINUTES_MS = 1000 * 60 * 30;
const TEN_SECONDS_MS = 10_000;
const MAX_RETRIES = 2;

export const defaultQueryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      staleTime: Infinity,
      gcTime: THIRTY_MINUTES_MS,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status === 401) return false;
        return failureCount < MAX_RETRIES;
      },
    },
    mutations: {
      retry: 0,
    },
  },
};

export const createQueryClient = (): QueryClient => {
  // A successful mutation almost always changes server state that some *other*
  // mounted query displays (dashboard aggregate, profile dashboard, symbol
  // state). Invalidating all active queries after any mutation makes every
  // surface reflect the change on the same tick instead of waiting for its own
  // poll interval. Single operator, few active queries, so the blanket refetch
  // is cheap. Not awaited: button pending stays tied to the mutation itself; the
  // refetch lands in the background.
  const client = new QueryClient({
    ...defaultQueryClientConfig,
    mutationCache: new MutationCache({
      onSuccess: () => void client.invalidateQueries(),
    }),
  });
  return client;
};

const referenceDataOverride = { staleTime: FIVE_MINUTES_MS } as const;
const archivePagedOverride = { gcTime: FIVE_MINUTES_MS } as const;
// Poll cadence for the dashboard aggregate. Kept strictly below the server-side
// read-through cache TTL (DASHBOARD_AGGREGATE_TTL_S) so consecutive polls land
// on a warm cache instead of forcing the account-wide fan-in on every request.
const dashboardAggregateOverride = {
  staleTime: TEN_SECONDS_MS,
  refetchInterval: TEN_SECONDS_MS,
} as const;
// Closed-trade totals change only when a trade closes, so a 30s poll keeps
// the realised-P/L card live without the 5s cadence the dashboard needs.
const THIRTY_SECONDS_MS = 30_000;
const closedTradesOverride = {
  staleTime: THIRTY_SECONDS_MS,
  refetchInterval: THIRTY_SECONDS_MS,
} as const;

export const queryDefaults = {
  exchangeInfo: () => ({ queryKey: ['exchange-info'] as const, ...referenceDataOverride }),
  notifyProviders: () => ({ queryKey: ['notify-providers'] as const, ...referenceDataOverride }),
  archive: (profileId: string, page: number) => ({
    queryKey: ['archive', profileId, page] as const,
    ...archivePagedOverride,
  }),
  dashboardAggregate: (accountId: string) => ({
    queryKey: ['dashboard-aggregate', accountId] as const,
    ...dashboardAggregateOverride,
  }),
  // `tz` is part of the key: the server resolves the day/week/month boundary in
  // that zone, so two zones are two different answers for the same period.
  closedTrades: (profileId: string, period: string, tz: string) => ({
    queryKey: ['closed-trades', profileId, period, tz] as const,
    ...closedTradesOverride,
  }),
  // Period-ranged discovery scoreboard (KPI strip toggle). Same cadence as
  // closed-trades: only changes when an auto trade closes.
  discoveryScoreboard: (profileId: string, period: string, tz: string) => ({
    queryKey: ['discovery-scoreboard', profileId, period, tz] as const,
    ...closedTradesOverride,
  }),
} as const;
