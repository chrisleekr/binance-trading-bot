import { useEffect, useState } from 'react';

import type { TechnicalsRecommendationItem } from '@app/contracts';

/**
 * Drives a 1-second re-render while any of `item`'s signals is within 60s of
 * its freshness expiry, so the panel's per-tab retry countdown and the active
 * tab's Buy-gate expiry suffix decrement smoothly between the 15s
 * recommendation polls instead of jumping a poll-cadence at a time. The
 * interval only runs while a countdown is in scope — a healthy panel pays no
 * re-render cost. Returns whether such a near-expiry signal exists so the
 * caller can branch on the same condition that arms the tick.
 *
 * `item` is the already-resolved recommendation row for the panel's symbol;
 * passing it in (rather than re-finding it) keeps the near-expiry scan and the
 * panel's body render reading the same single `items.find` result.
 */
export function useNearExpiryTick(
  item: TechnicalsRecommendationItem | undefined,
  useOnlyWithinMin: number,
  clock: () => number,
): boolean {
  const [, setTickKey] = useState(0);
  // Recompute on every render so a quiet → active transition starts the
  // interval and an active → quiet transition stops it.
  const hasNearExpirySignal = Boolean(
    item?.signals.some((s) => {
      if (s.signal === null) return false;
      const ageMs = clock() - s.signal.receivedAtMs;
      const remainingS = (useOnlyWithinMin * 60_000 - ageMs) / 1_000;
      return remainingS > 0 && remainingS <= 60;
    }),
  );
  useEffect(() => {
    if (!hasNearExpirySignal) return undefined;
    const id = setInterval(() => setTickKey((k) => k + 1), 1_000);
    return () => clearInterval(id);
  }, [hasNearExpirySignal]);
  return hasNearExpirySignal;
}
