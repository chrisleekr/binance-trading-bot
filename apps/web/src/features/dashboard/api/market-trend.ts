import { MarketTrendResponseSchema, type MarketTrendResponse } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

/** Query key for the global market-trend poll. */
export const marketTrendQueryKey = (): readonly unknown[] => ['market-trend'];

/**
 * GET /market-trend. The worker recomputes the snapshot every ~60s; `trend`
 * is null while the cron is warming, which the card renders as a warming
 * state rather than a fetch error.
 */
export const fetchMarketTrend = (): Promise<MarketTrendResponse> =>
  apiFetch(`/market-trend`, MarketTrendResponseSchema, { method: 'GET' });
