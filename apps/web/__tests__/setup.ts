import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

import { setActiveAccountId } from '@/shared/lib/account-scope';

// Every account-scoped API path is built via `accountPath`, which throws when
// no account is active. Component tests render those surfaces without mounting
// the `/accounts/$accountId` route that would set it, so seed a default active
// account for the whole suite. Tests asserting a specific account override this
// with their own `setActiveAccountId(...)`.
const DEFAULT_TEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

// CI's shared runner oversubscribes CPU across the parallel web suite, so a
// single render/query can stall for seconds while the event loop is starved.
// React Testing Library's default 1 s asyncUtilTimeout governs `findBy*` /
// `waitFor` and flakes under that load — and 5 s still tripped on different
// tests each run. 10 s absorbs the starvation spikes; kept below the 20 s
// `testTimeout` so a slow wait surfaces its own assertion, not a test-level
// timeout. Timeouts only bite on failure, so raising them costs nothing green.
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  cleanup();
});

// happy-dom 16 ships a Storage shim, but Bun's runtime exposes a separate
// global localStorage that lacks the standard methods. Make sure tests get a
// real Storage instance that supports getItem/setItem/removeItem/clear.
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  setActiveAccountId(DEFAULT_TEST_ACCOUNT_ID);
});

if (!globalThis.matchMedia) {
  globalThis.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
