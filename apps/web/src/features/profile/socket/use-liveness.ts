import { useEffect, useMemo, useState } from 'react';

import type { SocketSnapshot } from '@/features/profile/socket/registry';

const LIVE_THRESHOLD_MS = 10_000;

/**
 * Derived "a frame arrived in the last 10s" flag. Without an independent
 * ticker, `isLive` would only flip after a frame or status change — a socket
 * that goes silent would stay `isLive: true` forever because no input event
 * re-runs the memo. We sample `clock()` on a 1s interval while the socket is
 * open so the silence-driven transition fires on its own.
 */
export const useLiveness = (snapshot: SocketSnapshot, clock: () => number): boolean => {
  const [livenessTick, setLivenessTick] = useState(0);
  useEffect(() => {
    if (snapshot.status !== 'open') return undefined;
    const id = setInterval(() => setLivenessTick((n) => n + 1), 1_000);
    return (): void => clearInterval(id);
  }, [snapshot.status]);

  return useMemo(() => {
    // `livenessTick` is the silence-ticker dep — listed so the memo recomputes
    // each second while the socket is open, which is what flips `isLive` false
    // on prolonged silence.
    void livenessTick;
    return (
      snapshot.status === 'open' &&
      snapshot.lastMessageAt !== null &&
      clock() - snapshot.lastMessageAt < LIVE_THRESHOLD_MS
    );
  }, [snapshot, clock, livenessTick]);
};
