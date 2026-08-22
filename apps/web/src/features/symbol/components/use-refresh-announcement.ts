import { useState } from 'react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';

import type { TechnicalsHealthResponse, TechnicalsResponse } from '@app/contracts';

import {
  technicalsHealthQueryKey,
  technicalsRecommendationsQueryKey,
} from '@/features/technicals/api/technicals';
import { friendlyErrorLabel } from '@/features/technicals/lib/friendly-error-label';
import { humaniseAge } from '@/shared/lib/format-time';

export interface RefreshAnnouncement {
  /** aria-live message; empty until a manual refresh resolves. */
  readonly announcement: string;
  /** Operator-initiated refresh of both the recommendation and health polls. */
  readonly refresh: () => void;
  /** True while either poll is in flight or the post-click cooldown holds. */
  readonly refreshing: boolean;
}

/**
 * Owns the manual-refresh cooldown and the screen-reader announcement for the
 * Technicals panel. A refresh refetches both the recommendation and health
 * queries; when both settle, the outcome is announced via aria-live — but only
 * for operator-driven refreshes (`manualRefreshPending`), so the 15s
 * background poll does not make the SR chatter. A 1s `cooldown` debounces
 * consecutive clicks so an operator hammering the icon cannot stampede the API.
 */
export function useRefreshAnnouncement(
  profileId: string,
  recs: UseQueryResult<TechnicalsResponse>,
  health: UseQueryResult<TechnicalsHealthResponse>,
  clock: () => number,
): RefreshAnnouncement {
  const qc = useQueryClient();
  const [cooldown, setCooldown] = useState(false);
  const [refreshState, setRefreshState] = useState({ pending: false, announcement: '' });
  const refresh = (): void => {
    if (cooldown) return;
    setCooldown(true);
    setTimeout(() => setCooldown(false), 1_000);
    setRefreshState((current) => ({ ...current, pending: true }));
    void qc.refetchQueries({ queryKey: technicalsRecommendationsQueryKey(profileId) });
    void qc.refetchQueries({ queryKey: technicalsHealthQueryKey() });
  };
  const refreshing = recs.isFetching || health.isFetching || cooldown;
  if (refreshState.pending && !recs.isFetching && !health.isFetching) {
    const recsErr = recs.error instanceof Error ? recs.error.message : null;
    const healthErr = health.error instanceof Error ? health.error.message : null;
    const firstErr = recsErr ?? healthErr;
    const firstSignalMs =
      recs.data?.items
        .flatMap((i) => i.signals)
        .map((s) => s.signal?.receivedAtMs ?? null)
        .find((ms): ms is number => ms !== null) ?? null;
    const announcement = firstErr
      ? `Technicals refresh failed: ${friendlyErrorLabel(firstErr)}`
      : firstSignalMs === null
        ? 'Technicals refreshed; no signal available yet.'
        : `Technicals refreshed; signal ${humaniseAge(clock() - firstSignalMs, { suffix: ' ago' })}.`;
    setRefreshState({ pending: false, announcement });
  }

  return { announcement: refreshState.announcement, refresh, refreshing };
}
