import { useEffect } from 'react';

import { connect } from '@/features/profile/socket/connection';
import { clearTimer, REGISTRY, updateSnapshot } from '@/features/profile/socket/registry';

/**
 * Bridge browser network/visibility events onto the per-profile socket:
 * pause frame fan-out while the tab is hidden, force a `since=<lastSeq>`
 * resync on return to foreground, and drop to `offline` / recover on the
 * `online`/`offline` events. The listeners read through the registry rather
 * than closing over hook state, so they survive unmount/remount cleanly.
 */
export const useNetworkStatus = (profileId: string, clock: () => number): void => {
  useEffect(() => {
    const entry = REGISTRY.get(profileId);
    if (!entry) return;

    const onVisibility = (): void => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'hidden') {
        entry.paused = true;
      } else {
        entry.paused = false;
        connect(profileId, entry, clock);
      }
    };
    const onOnline = (): void => {
      if (entry.snapshot.status === 'offline') {
        updateSnapshot(entry, { status: 'reconnecting', attempt: 0 });
        connect(profileId, entry, clock);
      }
    };
    const onOffline = (): void => {
      entry.reconnectTimer = clearTimer(entry.reconnectTimer);
      updateSnapshot(entry, { status: 'offline' });
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return (): void => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [profileId, clock]);
};
