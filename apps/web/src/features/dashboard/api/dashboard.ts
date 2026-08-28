import {
  ClosedTradesResponse,
  DashboardAggregateResponse,
  type ClosedTradesPeriod,
} from '@app/contracts';

import { accountPath } from '@/shared/lib/account-scope';
import { apiFetch } from '@/shared/lib/api';
import { queryDefaults } from '@/shared/lib/query-client';

const fetchDashboardAggregate = (): Promise<DashboardAggregateResponse> =>
  apiFetch(accountPath('/dashboard-aggregate'), DashboardAggregateResponse);

/**
 * Aggregate for the active account. Keyed by `accountId` so switching accounts
 * never shows the previous account's profiles from cache; the account is read
 * from the route, and `accountPath` builds the request against the same active
 * account.
 */
export const dashboardAggregateQueryOptions = (accountId: string) => ({
  ...queryDefaults.dashboardAggregate(accountId),
  queryFn: fetchDashboardAggregate,
});

/**
 * Period P&L totals for a profile. `tz` resolves the period boundaries
 * (start-of-day/week/month) server-side, so it is the operator's configured
 * display zone and part of the cache key.
 */
const fetchClosedTrades = (
  profileId: string,
  period: ClosedTradesPeriod,
  tz: string,
): Promise<ClosedTradesResponse> => {
  return apiFetch(accountPath(`/profiles/${profileId}/closed-trades`), ClosedTradesResponse, {
    method: 'GET',
    query: { period, tz },
  });
};

/** Query options for the realised-P/L card; period and tz drive the cache key. */
export const closedTradesQueryOptions = (
  profileId: string,
  period: ClosedTradesPeriod,
  tz: string,
) => ({
  ...queryDefaults.closedTrades(profileId, period, tz),
  queryFn: () => fetchClosedTrades(profileId, period, tz),
});
