import { RetentionStatusResponseSchema, type RetentionStatusResponse } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

/** Fetch the worker's last-prune receipt for both retention crons. */
export const fetchRetentionStatus = (): Promise<RetentionStatusResponse> =>
  apiFetch('/retention-status', RetentionStatusResponseSchema, { method: 'GET' });

/** Stable React Query key for the retention-status poll. */
export const retentionStatusQueryKey = (): readonly string[] => ['retention-status'];
