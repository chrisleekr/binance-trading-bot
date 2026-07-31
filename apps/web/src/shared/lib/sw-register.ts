// Service-worker teardown. Registration lives in `pwa.ts` (vite-plugin-pwa);
// this module is the operator escape hatch that drops the worker and its
// caches so the app falls back to a network-only client.

/**
 * Operator emergency switch. Surfaces from the Settings page but exposed as a
 * function so other call sites (e.g. an error boundary that detects a stale
 * chunk fetch failure) can also unregister. Returns the number of service
 * worker registrations that were removed.
 */
export const unregisterServiceWorkers = async (): Promise<number> => {
  if (typeof navigator === 'undefined') return 0;
  const sw = (navigator as { serviceWorker?: ServiceWorkerContainer }).serviceWorker;
  if (!sw) return 0;
  const registrations = await sw.getRegistrations();
  let unregistered = 0;
  for (const registration of registrations) {
    if (await registration.unregister()) unregistered += 1;
  }
  const cachesApi = (globalThis as { caches?: CacheStorage }).caches;
  if (cachesApi) {
    const keys = await cachesApi.keys();
    await Promise.all(keys.map((k) => cachesApi.delete(k)));
  }
  return unregistered;
};
