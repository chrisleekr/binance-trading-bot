// Log-retention settings queries.
//
// PATCH rather than PUT: the card saves one section at a time, and arming deep
// capture must not have to restate the retention numbers it did not touch. The
// server returns the whole refreshed row either way, so the caller repopulates
// from the response instead of re-fetching.

import { RetentionConfigResponse, type RetentionConfigPatch } from '@app/contracts';

import { apiFetch } from '@/shared/lib/api';

export const retentionConfigQueryKey = ['retention-config'] as const;

export const fetchRetentionConfig = (): Promise<RetentionConfigResponse> =>
  apiFetch('/retention-config', RetentionConfigResponse, { method: 'GET' });

export const patchRetentionConfig = (
  body: RetentionConfigPatch,
): Promise<RetentionConfigResponse> =>
  apiFetch('/retention-config', RetentionConfigResponse, { method: 'PATCH', body });
