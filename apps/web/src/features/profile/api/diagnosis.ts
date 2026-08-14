import { z } from 'zod';
import {
  diagnosisRunSchema,
  discoveryFunnelResponseSchema,
  type DiagnosisRun,
} from '@app/contracts';

import { apiFetch, encodePathSegment } from '@/shared/lib/api';
import { accountPath } from '@/shared/lib/account-scope';

const diagnosisRunListSchema = z.array(diagnosisRunSchema);

export const diagnosisRunsQueryKey = (profileId: string) => ['diagnosis-runs', profileId] as const;

export const discoveryFunnelQueryKey = (profileId: string) =>
  ['discovery-funnel', profileId] as const;

/** Recent investigations, newest first. Rehydrates the header button on mount. */
export const fetchDiagnosisRuns = (profileId: string, limit = 5): Promise<DiagnosisRun[]> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/diagnosis/runs`),
    diagnosisRunListSchema,
    { query: { limit: String(limit) } },
  );

/** A run still being worked on. Anything terminal stops the poll. */
export const isRunLive = (run: DiagnosisRun | undefined): boolean =>
  run?.status === 'queued' || run?.status === 'running';

/** Start an investigation. Returns the seeded `queued` row, ladder included. */
export const startDiagnosis = (profileId: string, liveProbe: boolean): Promise<DiagnosisRun> =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/diagnosis/runs`),
    diagnosisRunSchema,
    { method: 'POST', body: { liveProbe } },
  );

const fetchDiscoveryFunnel = (profileId: string) =>
  apiFetch(
    accountPath(`/profiles/${encodePathSegment(profileId)}/discovery/funnel`),
    discoveryFunnelResponseSchema,
  );

/**
 * The always-visible funnel panel. Refreshed on the discovery scan's own scale
 * (a scan lands every refresh period, minutes apart), not on a poll cadence.
 */
export const discoveryFunnelQueryOptions = (profileId: string) => ({
  queryKey: discoveryFunnelQueryKey(profileId),
  queryFn: () => fetchDiscoveryFunnel(profileId),
  refetchInterval: 60_000,
});
