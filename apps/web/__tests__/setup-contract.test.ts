import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, useEffect } from 'react';
import { render } from '@testing-library/react';

type SetupContract = {
  readonly auditReactActWarnings?: () => void;
  readonly auditUnexpectedFetches?: () => void;
  readonly finishWebTest?: () => void;
  readonly reactActEnvironmentConfigured?: boolean;
};

const setupContract = (await import('./setup')) as SetupContract;
const explicitFetch = vi.fn<typeof fetch>();
const collectionSentinelInstalled = vi.isMockFunction(globalThis.fetch);
const collectionFetchFailure = collectionSentinelInstalled
  ? globalThis.fetch('https://native-network.invalid/collection-phase').then<unknown>(
      () => undefined,
      (error: unknown) => error,
    )
  : Promise.resolve(new Error('Collection-phase fetch sentinel was not installed'));
let collectionAuditFailure: unknown;
try {
  setupContract.auditUnexpectedFetches?.();
} catch (error) {
  collectionAuditFailure = error;
}

afterEach(() => {
  if (
    expect.getState().currentTestName ===
    'web test setup contract > restores explicit stubs to the fail-loud sentinel, never native fetch'
  ) {
    expect(() => setupContract.auditUnexpectedFetches?.()).toThrow(/unexpected unmocked fetch/i);
  }
});

describe('web test setup contract', () => {
  it('owns React act semantics for the entire test', () => {
    // Testing Library temporarily sets the global flag itself. This separate
    // setup-owned signal prevents that library side effect from satisfying the contract.
    expect(setupContract.reactActEnvironmentConfigured).toBe(true);
    expect(globalThis.IS_REACT_ACT_ENVIRONMENT).toBe(true);
  });

  it('audits an escaped fetch even when product code catches its rejection', async () => {
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
    if (!vi.isMockFunction(globalThis.fetch)) return;

    await globalThis.fetch('https://native-network.invalid/escaped').catch(() => undefined);
    expect(() => setupContract.auditUnexpectedFetches?.()).toThrow(/unexpected unmocked fetch/i);
    vi.mocked(globalThis.fetch).mockClear();
  });

  it('allows an explicit fetch stub for one test', async () => {
    explicitFetch.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', explicitFetch);

    await expect(globalThis.fetch('https://example.test/stubbed')).resolves.toHaveProperty(
      'status',
      204,
    );
  });

  it('restores explicit stubs to the fail-loud sentinel, never native fetch', async () => {
    expect(globalThis.fetch).not.toBe(explicitFetch);
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
    if (!vi.isMockFunction(globalThis.fetch)) return;

    await expect(globalThis.fetch('https://native-network.invalid/restored')).rejects.toThrow(
      /unexpected unmocked fetch/i,
    );
    vi.mocked(globalThis.fetch).mockClear();
  });

  it('restores a fetch spy to the fail-loud sentinel', async () => {
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
    if (!vi.isMockFunction(globalThis.fetch)) return;
    const sentinel = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));

    await globalThis.fetch('https://example.test/spied');
    spy.mockRestore();
    expect(globalThis.fetch).toBe(sentinel);
  });

  it('audits a caught collection-phase fetch before any test hook runs', async () => {
    expect(collectionSentinelInstalled).toBe(true);
    await expect(collectionFetchFailure).resolves.toBeInstanceOf(Error);
    expect(String(collectionAuditFailure)).toMatch(/unexpected unmocked fetch.*collection-phase/i);
  });

  it('audits an escaped fetch after mock call history is cleared', async () => {
    await globalThis.fetch('https://native-network.invalid/cleared').catch(() => undefined);
    vi.clearAllMocks();

    expect(() => setupContract.auditUnexpectedFetches?.()).toThrow(/unexpected unmocked fetch/i);
  });

  it.each([
    'The current testing environment is not configured to support act(...)',
    'An update to Example inside a test was not wrapped in act(...)',
  ])('fails centrally for React act warning: %s', (warning) => {
    expect(() => console.error(warning)).toThrow(/React test contract violated/);
    expect(() => setupContract.auditReactActWarnings?.()).toThrow(/React test contract violated/);
  });

  it('audits an act warning after a local console spy is restored', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    console.error('An update to Example inside a test was not wrapped in act(...)');
    vi.restoreAllMocks();

    expect(() => setupContract.auditReactActWarnings?.()).toThrow(/React test contract violated/);
  });

  it('completes React cleanup before reporting an act warning emitted during unmount', () => {
    const finishWebTest = setupContract.finishWebTest;
    expect(finishWebTest).toBeTypeOf('function');
    if (!finishWebTest) return;
    let cleanupCompleted = false;
    const CleanupProbe = () => {
      useEffect(
        () => () => {
          console.error('An update to CleanupProbe inside a test was not wrapped in act(...)');
          cleanupCompleted = true;
        },
        [],
      );
      return null;
    };
    render(createElement(CleanupProbe));

    expect(() => finishWebTest()).toThrow(/React test contract violated/);
    expect(cleanupCompleted).toBe(true);
  });

  it('keeps fetch diagnostics free of secrets and control characters', async () => {
    const targets = [
      'https://operator:password@example.test/private/path?token=secret#fragment',
      'https://example.test/safe\nInjected?token=secret#fragment',
      'http://[::1',
    ];

    for (const target of targets) await globalThis.fetch(target).catch(() => undefined);

    let diagnostic = '';
    try {
      setupContract.auditUnexpectedFetches?.();
    } catch (error) {
      diagnostic = String(error);
    }
    expect(diagnostic).toContain('/private/path');
    expect(diagnostic).toContain('<malformed-url>');
    expect(diagnostic).not.toMatch(/operator|password|token|secret|fragment|[\n\r]/);
  });

  it('restores an explicit stub through the actual cleanup seam', async () => {
    const finishWebTest = setupContract.finishWebTest;
    expect(finishWebTest).toBeTypeOf('function');
    if (!finishWebTest) return;
    const stub = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', stub);

    finishWebTest();

    expect(globalThis.fetch).not.toBe(stub);
    await expect(globalThis.fetch('https://native-network.invalid/after-cleanup')).rejects.toThrow(
      /unexpected unmocked fetch/i,
    );
    expect(() => setupContract.auditUnexpectedFetches?.()).toThrow(/unexpected unmocked fetch/i);
  });

  it('installs a fresh sentinel after cleanup of an unrestored fetch spy', async () => {
    const finishWebTest = setupContract.finishWebTest;
    expect(finishWebTest).toBeTypeOf('function');
    if (!finishWebTest) return;
    const sentinel = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 204 }));
    await globalThis.fetch('https://example.test/spied');

    finishWebTest();

    expect(globalThis.fetch).not.toBe(sentinel);
    expect(globalThis.fetch).not.toBe(spy);
    await expect(globalThis.fetch('https://native-network.invalid/after-spy')).rejects.toThrow(
      /unexpected unmocked fetch/i,
    );
    expect(() => setupContract.auditUnexpectedFetches?.()).toThrow(/unexpected unmocked fetch/i);
  });
});
