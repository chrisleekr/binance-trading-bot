import { StatusResponse } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

/** Query key for the build-and-liveness status poll. */
export const statusQueryKey = (): readonly unknown[] => ['status'];

/**
 * GET /status. Public build-and-liveness snapshot: api/worker SHAs + boot
 * times and the latest applied migration timestamp. Polled from the status
 * bar to surface api/worker code skew and worker-vs-migration lag.
 */
export const fetchStatus = (): Promise<StatusResponse> =>
  apiFetch('/status', StatusResponse, { method: 'GET' });
