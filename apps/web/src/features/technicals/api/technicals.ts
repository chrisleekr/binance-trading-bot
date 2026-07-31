import {
  TechnicalsHealthResponseSchema,
  TechnicalsResponse,
  type TechnicalsHealthResponse,
} from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

/** Query key for the per-profile TV recommendations poll. */
export const technicalsRecommendationsQueryKey = (profileId: string): readonly unknown[] => [
  'profile',
  'technicals',
  'recommendations',
  profileId,
];

/**
 * GET /profiles/:profileId/technicals/recommendations. Polled every 15s
 * from the symbol detail page. Symbols whose Redis key isn't populated yet
 * surface as `signal: null` — the panel renders that as "no signal yet"
 * rather than as a fetch error.
 */
export const fetchTechnicalsRecommendations = (profileId: string): Promise<TechnicalsResponse> =>
  apiFetch(accountPath(`/profiles/${profileId}/technicals/recommendations`), TechnicalsResponse, {
    method: 'GET',
  });

/** Query key for the global Technicals compute-job health poll. */
export const technicalsHealthQueryKey = (): readonly unknown[] => ['technicals', 'health'];

/**
 * GET /technicals/health. One row per interval the worker's fetch cron
 * has committed within the status-key TTL. Empty list means the cron
 * has not run lately — UI renders that as "technicals silent" rather
 * than as a fetch error.
 */
export const fetchTechnicalsHealth = (): Promise<TechnicalsHealthResponse> =>
  apiFetch(`/technicals/health`, TechnicalsHealthResponseSchema, { method: 'GET' });
