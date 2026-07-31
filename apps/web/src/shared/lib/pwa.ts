// PWA service-worker setup. Gated on `VITE_PWA === '1'` so a kill-build can
// ship with no worker at all.
//
// `registerType: 'prompt'` (vite.config.ts) keeps a new worker in `waiting`
// until the operator accepts the toast below: a silent reload mid-trade is
// forbidden.

import { registerSW } from 'virtual:pwa-register';
import { toast } from 'sonner';

import { unregisterServiceWorkers } from '@/shared/lib/sw-register';

/** Options for {@link setupPwa}. */
export interface SetupPwaOptions {
  /**
   * Force-enable registration. Defaults to the `VITE_PWA` build flag; tests
   * inject `true` directly because vitest's env-stub does not flow into vite's
   * `import.meta.env`.
   */
  readonly enabled?: boolean;
}

/**
 * Registers the service worker when the `VITE_PWA` build flag is set and wires
 * the update prompt. When the flag is unset it tears down any worker a prior
 * `VITE_PWA` build registered, so a kill-build self-heals to a network-only
 * client without operator action. Safe to call from the app entry point.
 */
export const setupPwa = (opts: SetupPwaOptions = {}): void => {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
  const enabled = opts.enabled ?? env['VITE_PWA'] === '1';
  if (!enabled) {
    void unregisterServiceWorkers().catch((error: unknown) => {
      console.error('Failed to unregister service workers', error);
    });
    return;
  }

  // `onNeedRefresh` fires only when a new worker is detected — always well
  // after first render — so sonner's <Toaster/> is mounted by the time the
  // toast is raised, even though `setupPwa` runs before React renders.
  const updateSW = registerSW({
    onNeedRefresh() {
      toast('App updated', {
        description: 'Reload to use the new version.',
        duration: Infinity,
        action: { label: 'Reload', onClick: () => void updateSW(true) },
      });
    },
  });
};
