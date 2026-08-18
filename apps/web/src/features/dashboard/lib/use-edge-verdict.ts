import { useQuery } from '@tanstack/react-query';
import { assessEdgeDecay, profitFactorFromGross } from '@app/contracts';

import { fetchBacktestRun } from '@/features/backtest/api/backtest';
import { fetchProfileArchive } from '@/features/profile/api/archive';
import { fetchProfile, profileQueryKey } from '@/features/profile/api/profile';
import { useTimezone } from '@/shared/context/timezone-context';
import { mergeRollupBuckets } from '@/shared/lib/live-scorecard';

/**
 * The live edge-decay verdict for one profile, computed with the SAME pure
 * function the worker uses to decide whether to pause entries. Returns null when
 * the profile has no monitor policy. Query keys match LiveVsBacktestCard's, so
 * react-query dedupes the underlying fetches — both consumers share one cache.
 *
 * Feeds assessEdgeDecay the UNROUNDED profit factor so the verdict agrees with
 * the worker's halt decision across the < 1 net-losing floor.
 */
export function useEdgeVerdict(profileId: string): ReturnType<typeof assessEdgeDecay> | null {
  const timeZone = useTimezone();
  const profile = useQuery({
    queryKey: profileQueryKey(profileId),
    queryFn: () => fetchProfile(profileId),
  });
  const archive = useQuery({
    queryKey: ['trade-archive', profileId, 'a', timeZone, 'rollup', 'scorecard'],
    queryFn: () => fetchProfileArchive(profileId, 'a', null, timeZone, 'rollup'),
    refetchInterval: 60_000,
  });
  const baselineId = profile.data?.baselineBacktestRunId ?? null;
  const baseline = useQuery({
    queryKey: ['backtest', 'run', profileId, baselineId],
    queryFn: () => fetchBacktestRun(profileId, baselineId as string),
    enabled: baselineId !== null,
  });

  // Null while the profile query is still loading (profile.data undefined) and
  // for any profile lacking an edge-monitor policy — both mean "no edge verdict
  // yet", so callers fall back to the gate headline / hide the edge badge.
  const monitor = profile.data?.enablementPolicy?.monitor;
  if (!monitor) return null;

  // The profile's own quote: a live profit factor built from two currencies added together is not a ratio of anything, and it gates entries.
  const bucket = mergeRollupBuckets(archive.data?.bySource ?? [], profile.data?.quoteAsset ?? '');
  return assessEdgeDecay({
    policy: monitor,
    hasBaseline: baselineId !== null && !!baseline.data?.result,
    baselineProfitFactor: baseline.data?.result?.metrics?.profitFactor ?? null,
    liveProfitFactor: profitFactorFromGross(bucket.grossProfit, bucket.grossLoss),
    liveTradeCount: bucket.tradeCount,
  });
}
