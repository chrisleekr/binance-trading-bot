// Owns the investigation's poll lifecycle for one profile.
//
// The run is durable, so the operator can close the drawer, reload, or come
// back later and find the same run in the same state. This hook rehydrates the
// newest run on mount and polls only while it is live.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiagnosisRun } from '@app/contracts';

import {
  diagnosisRunsQueryKey,
  fetchDiagnosisRuns,
  isRunLive,
  startDiagnosis,
} from '@/features/profile/api/diagnosis';

/** How often a live run is re-read. Matches the advisor's poll. */
const POLL_MS = 1500;

/**
 * Put a just-started run at the head of the cached list so the drawer renders
 * its ladder on the same tick as the click, instead of blank until the first
 * poll lands.
 */
const mergeDiagnosisRun = (prev: DiagnosisRun[] | undefined, row: DiagnosisRun): DiagnosisRun[] => [
  row,
  ...(prev ?? []).filter((r) => r.id !== row.id),
];

export function useDiagnosisRunStatus(profileId: string) {
  const queryClient = useQueryClient();
  // Poll only while the newest run is live, and stop the moment it is terminal.
  // Every step transition the operator sees comes from this refetch, never from
  // a local timer: a diagnostic that animates its own progress is lying about
  // the one thing it exists to measure.
  const query = useQuery({
    queryKey: diagnosisRunsQueryKey(profileId),
    queryFn: () => fetchDiagnosisRuns(profileId),
    refetchInterval: (q) => (isRunLive(q.state.data?.[0]) ? POLL_MS : false),
  });
  const latest = query.data?.[0];

  const start = useMutation({
    mutationFn: (liveProbe: boolean) => startDiagnosis(profileId, liveProbe),
    onSuccess: (row) => {
      queryClient.setQueryData<DiagnosisRun[]>(diagnosisRunsQueryKey(profileId), (prev) =>
        mergeDiagnosisRun(prev, row),
      );
    },
  });

  return {
    latest,
    isLive: isRunLive(latest),
    isLoading: query.isLoading,
    start,
  };
}
