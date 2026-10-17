import { useQuery } from '@tanstack/react-query';
import { assessEdgeDecay, profitFactorFromGross } from '@app/contracts';

import { fetchBacktestRun } from '@/features/backtest/api/backtest';
import { fetchProfileArchive } from '@/features/profile/api/archive';
import { fetchProfile, profileQueryKey } from '@/features/profile/api/profile';
import { useTimezone } from '@/shared/context/timezone-context';
import { mergeRollupBuckets } from '@/shared/lib/live-scorecard';

/**
 * The reads every live-vs-backtest surface is built from: the profile, the archive rollup over the comparison window, and the pinned baseline run. One hook, so the badge, the card and the gate page share one cache entry per read instead of three hand-spelled query keys that can drift apart and double a 60s poll.
 *
 * The window starts at the baseline's pin time when there is one, so trades recorded under an earlier config are not judged against a baseline pinned for the current one; without a pin time it is all time. The archive read waits for the profile, because firing it first would fetch the all-time window and then refetch the pinned one. That keeps the archive pending for as long as the profile is pending, and for good if the profile read fails, so a consumer must check `profile.isError` before `archive.isPending` and must not read an empty bucket or a null pin as fact until both have landed.
 *
 * @param profileId - Profile whose live archive and pinned baseline are read.
 * @returns The three queries, plus the baseline run id and the window start (ISO, or null for all time) they were keyed on.
 */
export function useScorecardInputs(profileId: string) {
  const timeZone = useTimezone();
  const profile = useQuery({
    queryKey: profileQueryKey(profileId),
    queryFn: () => fetchProfile(profileId),
  });
  const baselineId = profile.data?.baselineBacktestRunId ?? null;
  const pinnedAt = profile.data?.baselinePinnedAt ?? null;
  const archive = useQuery({
    queryKey: ['trade-archive', profileId, 'a', timeZone, 'rollup', 'scorecard', pinnedAt],
    queryFn: () =>
      fetchProfileArchive(profileId, {
        period: 'a',
        cursor: null,
        tz: timeZone,
        view: 'rollup',
        from: pinnedAt ?? undefined,
      }),
    enabled: profile.data !== undefined,
    refetchInterval: 60_000,
  });
  const baseline = useQuery({
    queryKey: ['backtest', 'run', profileId, baselineId],
    queryFn: () => fetchBacktestRun(profileId, baselineId as string),
    enabled: baselineId !== null,
  });
  return { profile, archive, baseline, baselineId, pinnedAt };
}

/**
 * The live edge-decay verdict for one profile, computed with the same pure function the worker uses for its advisory notification, over the same window (trades recorded since the baseline was pinned). Returns null when the profile has no monitor policy or fee accounting is incomplete.
 *
 * Feeds assessEdgeDecay the unrounded profit factor so the browser and worker advisory verdicts agree across the less-than-one net-losing floor.
 *
 * @param profileId - Profile whose live archive and pinned baseline supply the advisory comparison.
 * @returns The current advisory assessment, or null when inputs are unavailable or incomplete.
 */
export function useEdgeVerdict(profileId: string): ReturnType<typeof assessEdgeDecay> | null {
  const { profile, archive, baseline, baselineId } = useScorecardInputs(profileId);

  // Null while the profile query is still loading (profile.data undefined) and
  // for any profile lacking an edge-monitor policy — both mean "no edge verdict
  // yet", so callers fall back to the gate headline / hide the edge badge.
  const monitor = profile.data?.enablementPolicy?.monitor;
  if (!monitor) return null;
  // No archive yet (pending or failed): an empty sample would read as "0 live trades", which states a fact the page never loaded. A failed 60s refetch keeps the last good data, so `isError` is checked too, or a stale verdict would sit under the "couldn't load" line.
  if (archive.data === undefined || archive.isError) return null;

  // The profile's own quote: a live profit factor built from two currencies added together is not a ratio of anything.
  const bucket = mergeRollupBuckets(archive.data.bySource, profile.data?.quoteAsset ?? '');
  // The same bar `edge-decay-monitor.cron.ts` applies before it sends the Slack alert, over the same window narrowed to the same quote: a badge on screen that the alert channel would never send is a disagreement the operator has no way to see. Only `unknown` withholds the verdict, because only `unknown` is missing a charge.
  if (bucket.feeBasis === 'unknown') return null;
  return assessEdgeDecay({
    policy: monitor,
    hasBaseline: baselineId !== null && !!baseline.data?.result,
    baselineProfitFactor: baseline.data?.result?.metrics?.profitFactor ?? null,
    liveProfitFactor: profitFactorFromGross(bucket.grossProfit, bucket.grossLoss),
    // The same denominator the cron judges its sample floor against: the profit factor above spans the fee-valued cycles only, so a badge decided on the whole-window count would appear at a sample the alert channel considers too small to speak on.
    liveTradeCount: bucket.netTradeCount,
  });
}
