// Owns the backtest advisor's poll lifecycle for one run. The advisor is
// durable per (profile, run, variant): this query rehydrates saved variants on
// mount (so a reload shows them with no fresh model call) and polls only while
// a variant is still generating. Splitting it out of the component keeps the
// poll/merge logic — the part most prone to a stale-closure or refetch bug — in
// one cohesive, testable unit.

import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdvisorListResponse,
  AdvisorResult,
  AdvisorVariant,
  ImproveConfigMode,
} from '@app/contracts';

import {
  backtestAdvisorQueryKey,
  fetchAdvisorResults,
  startAdvisor,
} from '@/features/backtest/api/backtest';

/**
 * Merge one advisor row into the cached list, replacing any existing row for the
 * same variant. Used to seed a just-started `running` row (from the 202) and a
 * just-persisted `manual` row into the poll cache, so the UI reflects the change
 * on the same tick instead of waiting for the next refetch round-trip.
 */
export const mergeAdvisorRow = (
  prev: AdvisorListResponse | undefined,
  row: AdvisorResult,
): AdvisorListResponse => {
  const others = (prev?.results ?? []).filter((r) => r.variant !== row.variant);
  return { results: [...others, row] };
};

/**
 * Resolve a run's advisor lifecycle. The list query polls every 1.5s while any
 * variant is `running` and stops once all are terminal; `start` enqueues (or
 * regenerates) one variant and seeds its `running` row so polling picks it up.
 */
export function useAdvisorRunStatus(profileId: string, runId: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: backtestAdvisorQueryKey(profileId, runId),
    queryFn: () => fetchAdvisorResults(profileId, runId),
    refetchInterval: (q) =>
      (q.state.data?.results ?? []).some((r) => r.status === 'running') ? 1500 : false,
  });

  const results = useMemo(() => query.data?.results ?? [], [query.data]);
  const byVariant = useMemo(() => {
    const map = new Map<AdvisorVariant, AdvisorResult>();
    for (const r of results) map.set(r.variant, r);
    return map;
  }, [results]);

  const seedRow = (row: AdvisorResult): void => {
    queryClient.setQueryData<AdvisorListResponse>(
      backtestAdvisorQueryKey(profileId, runId),
      (prev) => mergeAdvisorRow(prev, row),
    );
  };

  const start = useMutation({
    mutationFn: (variant: ImproveConfigMode) => startAdvisor(profileId, runId, variant),
    onSuccess: seedRow,
  });

  return { byVariant, results, isFetching: query.isFetching, start, seedRow };
}
