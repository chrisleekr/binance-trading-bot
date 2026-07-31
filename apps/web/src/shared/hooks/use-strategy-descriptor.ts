import { useQuery } from '@tanstack/react-query';

import { type StrategyDescriptor } from '@app/contracts';

import { fetchProfile, profileQueryKey } from '@/features/profile/api/profile';
import { strategiesQueryOptions } from '@/features/profile/api/strategies';

/**
 * Resolve the strategy descriptor a profile runs, from the two reads every call
 * site would otherwise duplicate: the bare profile row (for its strategy name +
 * version) and the strategy registry (for the descriptor).
 *
 * One home for the match choice, which diverges by design: `matchVersion` keys
 * on `name@version` (the exact pinned build), while the default keys on name
 * only, so a profile pinned to a since-bumped strategy_version still resolves
 * the live plugin's descriptor. Never throws: returns undefined while the
 * profile query is pending or when no descriptor matches. The queries mirror the
 * shapes the sites already issue, so React Query dedupes against their own.
 */
export function useStrategyDescriptor(
  profileId: string,
  opts?: { matchVersion?: boolean },
): StrategyDescriptor | undefined {
  const profile = useQuery({
    queryKey: profileQueryKey(profileId),
    queryFn: () => fetchProfile(profileId),
  });
  const strategies = useQuery(strategiesQueryOptions);

  const name = profile.data?.strategyName;
  if (name === undefined) return undefined;

  return strategies.data?.find((s) =>
    opts?.matchVersion
      ? `${s.name}@${s.version}` === `${name}@${profile.data?.strategyVersion}`
      : s.name === name,
  );
}
