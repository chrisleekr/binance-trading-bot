import { useQuery } from '@tanstack/react-query';
import { assessEdgeDecay, profitFactorFromGross } from '@app/contracts';

import { fetchBacktestRun } from '@/features/backtest/api/backtest';
import { fetchProfileArchive } from '@/features/profile/api/archive';
import { fetchProfile, profileQueryKey } from '@/features/profile/api/profile';
import { useTimezone } from '@/shared/context/timezone-context';
import { mergeRollupBuckets } from '@/shared/lib/live-scorecard';

/**
 * The live edge-decay verdict for one profile, computed with the same pure function the worker uses for its advisory notification. Returns null when the profile has no monitor policy or fee accounting is incomplete. Query keys match LiveVsBacktestCard's, so react-query dedupes the underlying fetches.
 *
 * Feeds assessEdgeDecay the unrounded profit factor so the browser and worker advisory verdicts agree across the less-than-one net-losing floor.
 *
 * @param profileId - Profile whose live archive and pinned baseline supply the advisory comparison.
 * @returns The current advisory assessment, or null when inputs are unavailable or incomplete.
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

  // The profile's own quote: a live profit factor built from two currencies added together is not a ratio of anything.
  const bucket = mergeRollupBuckets(archive.data?.bySource ?? [], profile.data?.quoteAsset ?? '');
  // The same bar `edge-decay-monitor.cron.ts` applies before it sends the Slack alert, over the same window narrowed to the same quote: a badge on screen that the alert channel would never send is a disagreement the operator has no way to see. Only `unknown` withholds the verdict, because only `unknown` is missing a charge.
  if (bucket.feeBasis === 'unknown') return null;
  return assessEdgeDecay({
    policy: monitor,
    hasBaseline: baselineId !== null && !!baseline.data?.result,
    baselineProfitFactor: baseline.data?.result?.metrics?.profitFactor ?? null,
    liveProfitFactor: profitFactorFromGross(bucket.grossProfit, bucket.grossLoss),
    liveTradeCount: bucket.tradeCount,
  });
}
