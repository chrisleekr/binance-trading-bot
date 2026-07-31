// PWA registration-gate tests. `virtual:pwa-register` is a vite-plugin-pwa
// build-time virtual module, mocked here. The `enabled` override stands in for
// the `VITE_PWA` flag because vitest's env-stub does not reach vite's
// `import.meta.env`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerSW } = vi.hoisted(() => ({ registerSW: vi.fn(() => vi.fn()) }));
const { unregisterServiceWorkers } = vi.hoisted(() => ({
  unregisterServiceWorkers: vi.fn(async () => 0),
}));
vi.mock('virtual:pwa-register', () => ({ registerSW }));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@/shared/lib/sw-register', () => ({ unregisterServiceWorkers }));

import { setupPwa } from '../src/shared/lib/pwa.js';

describe('setupPwa', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tears down any existing worker and does not register when disabled', () => {
    setupPwa({ enabled: false });
    expect(registerSW).not.toHaveBeenCalled();
    expect(unregisterServiceWorkers).toHaveBeenCalledOnce();
  });

  it('registers a worker and does not tear down when enabled', () => {
    setupPwa({ enabled: true });
    expect(registerSW).toHaveBeenCalledOnce();
    expect(unregisterServiceWorkers).not.toHaveBeenCalled();
  });
});
