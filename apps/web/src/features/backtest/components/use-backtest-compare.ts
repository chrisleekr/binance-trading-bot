// Comparison slice of the backtest workbench: the Verdict header's parent and
// baseline anchor runs, plus the pin/unpin baseline mutations. Anchors are
// fetched only when the viewed run is done and the anchor id differs from it, so
// a run is never compared against itself.

import { useMutation, useQuery, type QueryClient } from '@tanstack/react-query';

import { type BacktestRunDetail } from '@app/contracts';
import { errorMessage } from '@/shared/lib/api';
import { profileQueryKey } from '@/features/profile/api/profile';
import { patchProfile } from '@/features/profile/api/profiles-mutations';
import { backtestRunQueryKey, fetchBacktestRun } from '@/features/backtest/api/backtest';

type Banner = { kind: 'ok' | 'err'; message: string } | null;

/**
 * Fetch a comparison-anchor run (parent or baseline) for the Verdict header.
 * Enabled only when the viewed run is done and the anchor id exists and differs
 * from the viewed run (a run is never its own anchor), so no fetch fires on a
 * null id. A stable disabled queryKey keeps the hook order constant.
 */
function useAnchorRun(
  profileId: string,
  runId: string | null,
  viewedDone: boolean,
  activeRunId: string | null,
): ReturnType<typeof useQuery<BacktestRunDetail>> {
  return useQuery({
    queryKey: runId ? backtestRunQueryKey(profileId, runId) : ['backtest', 'run', 'anchor-none'],
    queryFn: () => fetchBacktestRun(profileId, runId as string),
    enabled: viewedDone && runId !== null && runId !== activeRunId,
  });
}

/** A done anchor run with a result, ready for the header; null otherwise. */
function toAnchor(
  query: ReturnType<typeof useAnchorRun>,
  runId: string | null,
): { runId: string; result: NonNullable<BacktestRunDetail['result']> } | null {
  return runId && query.data?.status === 'done' && query.data.result
    ? { runId, result: query.data.result }
    : null;
}

export interface BacktestCompareArgs {
  profileId: string;
  activeRunId: string | null;
  viewedDone: boolean;
  parentRunId: string | null;
  baselineRunId: string | null;
  setBanner: (b: Banner) => void;
  queryClient: QueryClient;
}

export function useBacktestCompare({
  profileId,
  activeRunId,
  viewedDone,
  parentRunId,
  baselineRunId,
  setBanner,
  queryClient,
}: BacktestCompareArgs) {
  const parentRun = useAnchorRun(profileId, parentRunId, viewedDone, activeRunId);
  const baselineRun = useAnchorRun(profileId, baselineRunId, viewedDone, activeRunId);

  const parentAnchor = parentRunId !== activeRunId ? toAnchor(parentRun, parentRunId) : null;
  const baselineAnchor =
    baselineRunId !== activeRunId ? toAnchor(baselineRun, baselineRunId) : null;

  // Pin the finished run as this profile's live-scorecard baseline.
  const pinBaseline = useMutation({
    mutationFn: (runId: string) => patchProfile(profileId, { baselineBacktestRunId: runId }),
    onSuccess: () => {
      setBanner({
        kind: 'ok',
        message: 'Pinned as the live baseline. See the dashboard scorecard.',
      });
      void queryClient.invalidateQueries({ queryKey: profileQueryKey(profileId) });
    },
    onError: (err) => setBanner({ kind: 'err', message: errorMessage(err) }),
  });

  // Clear the pinned baseline (set null).
  const unpinBaseline = useMutation({
    mutationFn: () => patchProfile(profileId, { baselineBacktestRunId: null }),
    onSuccess: () => {
      setBanner({
        kind: 'ok',
        message: 'Unpinned the live baseline. This run can now be deleted.',
      });
      void queryClient.invalidateQueries({ queryKey: profileQueryKey(profileId) });
    },
    onError: (err) => setBanner({ kind: 'err', message: errorMessage(err) }),
  });

  return {
    parentAnchor,
    baselineAnchor,
    pinBaseline,
    unpinBaseline,
    baselineBacktestRunId: baselineRunId,
  };
}
