import { useEffect, useRef, useState } from 'react';
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
  // Flags a refresh initiated by the operator (vs the background poll) so the
  // announcement only fires for operator-driven refreshes.
  const manualRefreshPending = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const refresh = (): void => {
    if (cooldown) return;
    setCooldown(true);
    setTimeout(() => setCooldown(false), 1_000);
    manualRefreshPending.current = true;
    void qc.refetchQueries({ queryKey: technicalsRecommendationsQueryKey(profileId) });
    void qc.refetchQueries({ queryKey: technicalsHealthQueryKey() });
  };
  const refreshing = recs.isFetching || health.isFetching || cooldown;
  const bothQueriesIdle = !recs.isFetching && !health.isFetching;
  // Capture `clock` in a ref so the announcement effect can read the current
  // wall-clock without listing the (potentially re-bound) function in its dep
  // array — an inline-bound prop would otherwise re-fire the effect every render.
  const clockRef = useRef(clock);
  useEffect(() => {
    clockRef.current = clock;
  }, [clock]);
  // When both queries finish after a manual refresh, announce the outcome.
  // Success quotes the freshest signal's staleness; failure quotes the
  // friendly error label so SR users hear something actionable.
  useEffect(() => {
    if (!manualRefreshPending.current || !bothQueriesIdle) return;
    manualRefreshPending.current = false;
    const recsErr = recs.error instanceof Error ? recs.error.message : null;
    const healthErr = health.error instanceof Error ? health.error.message : null;
    const firstErr = recsErr ?? healthErr;
    if (firstErr) {
      setAnnouncement(`Technicals refresh failed: ${friendlyErrorLabel(firstErr)}`);
      return;
    }
    const firstSignalMs =
      recs.data?.items
        .flatMap((i) => i.signals)
        .map((s) => s.signal?.receivedAtMs ?? null)
        .find((ms): ms is number => ms !== null) ?? null;
    if (firstSignalMs === null) {
      setAnnouncement('Technicals refreshed; no signal available yet.');
    } else {
      setAnnouncement(
        `Technicals refreshed; signal ${humaniseAge(clockRef.current() - firstSignalMs, { suffix: ' ago' })}.`,
      );
    }
  }, [bothQueriesIdle, recs.data, recs.error, health.error]);

  return { announcement, refresh, refreshing };
}
