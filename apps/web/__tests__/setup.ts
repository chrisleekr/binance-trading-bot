import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi, type Mock } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

import { setActiveAccountId } from '@/shared/lib/account-scope';

// Every account-scoped API path is built via `accountPath`, which throws when
// no account is active. Component tests render those surfaces without mounting
// the `/accounts/$accountId` route that would set it, so seed a default active
// account for the whole suite. Tests asserting a specific account override this
// with their own `setActiveAccountId(...)`.
const DEFAULT_TEST_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const ACT_ENVIRONMENT_WARNING =
  'The current testing environment is not configured to support act(...)';
const UNWRAPPED_UPDATE_WARNING = 'inside a test was not wrapped in act(...)';
const UNEXPECTED_FETCH_PREFIX = 'Unexpected unmocked fetch in web test';
const MALFORMED_FETCH_TARGET = '<malformed-url>';

export const reactActEnvironmentConfigured = true;
globalThis.IS_REACT_ACT_ENVIRONMENT = reactActEnvironmentConfigured;

type FetchSentinel = Mock<typeof fetch>;
let fetchSentinel: FetchSentinel | undefined;
let unexpectedFetchTargets: string[] = [];

const fetchTarget = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const diagnosticFetchTarget = (target: string): string => {
  try {
    const path = new URL(target, 'http://web-test.invalid').pathname;
    const printablePath = [...path]
      .filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint > 31 && codePoint !== 127;
      })
      .join('');
    return printablePath || '/';
  } catch {
    return MALFORMED_FETCH_TARGET;
  }
};

const installFetchSentinel = (): void => {
  unexpectedFetchTargets = [];
  fetchSentinel = vi.fn<typeof fetch>((input) => {
    const target = fetchTarget(input);
    unexpectedFetchTargets.push(target);
    return Promise.reject(
      new Error(`${UNEXPECTED_FETCH_PREFIX}: ${diagnosticFetchTarget(target)}`),
    );
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: fetchSentinel,
    configurable: true,
    writable: true,
  });
};

export const auditUnexpectedFetches = (): void => {
  if (unexpectedFetchTargets.length === 0) return;
  const targets = unexpectedFetchTargets;
  unexpectedFetchTargets = [];
  throw new Error(`${UNEXPECTED_FETCH_PREFIX}: ${targets.map(diagnosticFetchTarget).join(', ')}`);
};

const originalConsoleError = console.error.bind(console);
const isReactActWarning = (args: readonly unknown[]): boolean => {
  const message = String(args[0] ?? '');
  return message.includes(ACT_ENVIRONMENT_WARNING) || message.includes(UNWRAPPED_UPDATE_WARNING);
};

let consoleErrorGuard: Mock<typeof console.error> | undefined;
let recordedActWarnings: unknown[][] = [];
let cleanupInProgress = false;

const recordOrFailOnReactActWarning = (...args: unknown[]): void => {
  if (isReactActWarning(args)) {
    recordedActWarnings.push(args);
    if (cleanupInProgress) return;
    throw new Error(`React test contract violated: ${String(args[0])}`);
  }
  originalConsoleError(...args);
};

const installConsoleErrorGuard = (): void => {
  recordedActWarnings = [];
  consoleErrorGuard = vi.fn<typeof console.error>(recordOrFailOnReactActWarning);
  Object.defineProperty(console, 'error', {
    value: consoleErrorGuard,
    configurable: true,
    writable: true,
  });
};

export const auditReactActWarnings = (): void => {
  const calls = consoleErrorGuard?.mock.calls ?? [];
  const warning = recordedActWarnings[0] ?? calls.find(isReactActWarning);
  recordedActWarnings = [];
  consoleErrorGuard?.mockClear();
  if (warning) throw new Error(`React test contract violated: ${String(warning[0])}`);
};

// CI's shared runner oversubscribes CPU across the parallel web suite, so a
// single render/query can stall for seconds while the event loop is starved.
// React Testing Library's default 1 s asyncUtilTimeout governs `findBy*` /
// `waitFor` and flakes under that load — and 5 s still tripped on different
// tests each run. 10 s absorbs the starvation spikes; kept below the 20 s
// `testTimeout` so a slow wait surfaces its own assertion, not a test-level
// timeout. Timeouts only bite on failure, so raising them costs nothing green.
configure({ asyncUtilTimeout: 10_000 });

export const finishWebTest = (): void => {
  try {
    const warningBeforeCleanup = consoleErrorGuard?.mock.calls.find(isReactActWarning);
    consoleErrorGuard?.mockImplementation(recordOrFailOnReactActWarning).mockClear();
    if (consoleErrorGuard) {
      Object.defineProperty(console, 'error', {
        value: consoleErrorGuard,
        configurable: true,
        writable: true,
      });
    }
    cleanupInProgress = true;
    try {
      cleanup();
    } finally {
      cleanupInProgress = false;
    }
    // Every check runs before anything throws. The `finally` below reinstalls
    // the fetch sentinel, which drops what it recorded, so a test that both
    // warns and leaks a request would lose the request evidence if the first
    // failure short-circuited the rest.
    const failures: Error[] = [];
    if (warningBeforeCleanup) {
      failures.push(new Error(`React test contract violated: ${String(warningBeforeCleanup[0])}`));
    }
    for (const audit of [auditReactActWarnings, auditUnexpectedFetches]) {
      try {
        audit();
      } catch (error) {
        failures.push(error as Error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Web test contract violated');
  } finally {
    vi.unstubAllGlobals();
    installFetchSentinel();
    installConsoleErrorGuard();
    globalThis.IS_REACT_ACT_ENVIRONMENT = reactActEnvironmentConfigured;
  }
};

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

export const beginWebTest = (): void => {
  auditReactActWarnings();
  auditUnexpectedFetches();
  vi.unstubAllGlobals();
  installFetchSentinel();
  installConsoleErrorGuard();
  globalThis.IS_REACT_ACT_ENVIRONMENT = reactActEnvironmentConfigured;
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  });
  setActiveAccountId(DEFAULT_TEST_ACCOUNT_ID);
};

// Test-file imports run before the first beforeEach, so guards must already be live.
installFetchSentinel();
installConsoleErrorGuard();

beforeEach(beginWebTest);
afterEach(finishWebTest);

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
