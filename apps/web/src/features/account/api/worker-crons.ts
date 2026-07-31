import { WorkerCronsResponse } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

/** Query key for the per-cron worker-health poll. */
export const workerCronsQueryKey = ['worker-crons'] as const;

/**
 * GET /worker/crons. Per-cron last-run status from the worker's cron-status
 * recorder. Polled by the ops health panel so a stalled or erroring cron is
 * visible without scraping logs.
 */
export const fetchWorkerCrons = (): Promise<WorkerCronsResponse> =>
  apiFetch('/worker/crons', WorkerCronsResponse);
