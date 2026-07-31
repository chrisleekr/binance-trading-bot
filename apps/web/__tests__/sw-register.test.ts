// Service-worker teardown tests. Registration moved to vite-plugin-pwa
// (`src/shared/lib/pwa.ts`); this module now only unregisters.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { unregisterServiceWorkers } from '../src/shared/lib/sw-register.js';

const stubNavigatorWith = (sw: unknown): void => {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { serviceWorker: sw },
  });
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unregisterServiceWorkers', () => {
  it('returns 0 when no SW runtime is present', async () => {
    stubNavigatorWith(undefined);
    expect(await unregisterServiceWorkers()).toBe(0);
  });

  it('counts and unregisters every registration, then drops every cache', async () => {
    const r1 = { unregister: vi.fn(async () => true) };
    const r2 = { unregister: vi.fn(async () => true) };
    stubNavigatorWith({ getRegistrations: async () => [r1, r2] });
    const cachesStub = {
      keys: vi.fn(async () => ['a', 'b']),
      delete: vi.fn(async () => true),
    };
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: cachesStub });
    const count = await unregisterServiceWorkers();
    expect(count).toBe(2);
    expect(cachesStub.delete).toHaveBeenCalledTimes(2);
  });
});
