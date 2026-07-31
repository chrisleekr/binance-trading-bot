import { StrategyList } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

/**
 * Cache key for the strategy registry. Registry is stable per server boot,
 * so the wizard can reuse one query across step changes without refetching.
 */
const STRATEGIES_QUERY_KEY = ['strategies'] as const;

const fetchStrategies = (): Promise<StrategyList> => apiFetch('/strategies', StrategyList);

/**
 * Strategy registry options. `staleTime: Infinity` because the registry only
 * changes on server boot; the SPA picks up new strategies at the next reload,
 * not mid-session.
 */
export const strategiesQueryOptions = {
  queryKey: STRATEGIES_QUERY_KEY,
  queryFn: fetchStrategies,
  staleTime: Number.POSITIVE_INFINITY,
} as const;
