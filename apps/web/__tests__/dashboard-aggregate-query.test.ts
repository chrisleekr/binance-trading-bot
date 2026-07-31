import { describe, expect, it } from 'vitest';

import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

describe('dashboardAggregateQueryOptions', () => {
  it('keys the canonical query by account', () => {
    expect(dashboardAggregateQueryOptions(ACCOUNT_ID).queryKey).toEqual([
      'dashboard-aggregate',
      ACCOUNT_ID,
    ]);
  });

  it('polls every 10 seconds, below the server-side aggregate cache TTL', () => {
    const options = dashboardAggregateQueryOptions(ACCOUNT_ID);
    expect(options.refetchInterval).toBe(10_000);
    expect(options.staleTime).toBe(10_000);
  });

  it('exposes a queryFn', () => {
    expect(typeof dashboardAggregateQueryOptions(ACCOUNT_ID).queryFn).toBe('function');
  });
});
