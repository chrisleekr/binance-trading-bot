// Unit tests for useStrategyDescriptor: the shared profile→descriptor resolver.
// Exercised through the network layer (the same fetch-mock the site suites use)
// so the two queries run for real, covering the name-only vs name@version match
// choice and the pending / no-match paths that each return undefined.

import type { ReactNode } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../src/shared/lib/query-client.js';
import { useStrategyDescriptor } from '../src/shared/hooks/use-strategy-descriptor.js';

const PROFILE_ID = 'p1';

const profile = (strategyVersion: string) => ({
  id: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000010',
  name: 'BTC bot',
  strategyName: 'trailing-trade',
  strategyVersion,
  config: { symbol: 'BTCUSDT' },
  enabled: true,
  binanceMode: 'live' as const,
  quoteAsset: 'USDT',
  createdAt: '2026-05-10T05:00:00.000Z',
  updatedAt: '2026-05-10T05:00:00.000Z',
});

const descriptor = (version: string) => ({
  name: 'trailing-trade',
  version,
  displayName: `Trailing Trade ${version}`,
  description: 'desc',
  configSchema: { type: 'object', properties: {} },
  overrideConfigSchema: { type: 'object', properties: {} },
  defaultConfig: {},
  operatorActions: [],
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Route the profile + strategies reads to the responder; a never-resolving
// promise models a still-pending profile query.
const setUp = (responder: (url: string) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return wrapper;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useStrategyDescriptor', () => {
  it('name-only match resolves the live plugin even at a since-bumped version', async () => {
    // Profile pinned to 3.0.0; registry carries only 1.0.0 and 2.0.0. Name-only
    // still resolves (returns the first name match), version is diagnostic.
    const wrapper = setUp((url) => {
      if (url.endsWith('/profiles/p1')) return json(profile('3.0.0'));
      if (url.endsWith('/strategies')) return json([descriptor('1.0.0'), descriptor('2.0.0')]);
      return new Response('not found', { status: 404 });
    });
    const { result } = renderHook(() => useStrategyDescriptor(PROFILE_ID), { wrapper });
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current?.version).toBe('1.0.0');
  });

  it('matchVersion keys on name@version and skips a same-name different-version entry', async () => {
    const wrapper = setUp((url) => {
      if (url.endsWith('/profiles/p1')) return json(profile('2.0.0'));
      if (url.endsWith('/strategies')) return json([descriptor('1.0.0'), descriptor('2.0.0')]);
      return new Response('not found', { status: 404 });
    });
    const { result } = renderHook(() => useStrategyDescriptor(PROFILE_ID, { matchVersion: true }), {
      wrapper,
    });
    // Resolves the 2.0.0 entry, proving it walked past the same-name 1.0.0.
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current?.version).toBe('2.0.0');
  });

  it('matchVersion returns undefined when the pinned version is absent from the registry', async () => {
    // Same setup as the name-only case (profile 3.0.0, registry 1.0.0 + 2.0.0),
    // but matchVersion drops it rather than falling back to a name match. This is
    // the divergence: name-only resolves the live plugin, name@version does not.
    const wrapper = setUp((url) => {
      if (url.endsWith('/profiles/p1')) return json(profile('3.0.0'));
      if (url.endsWith('/strategies')) return json([descriptor('1.0.0'), descriptor('2.0.0')]);
      return new Response('not found', { status: 404 });
    });
    const { result } = renderHook(() => useStrategyDescriptor(PROFILE_ID, { matchVersion: true }), {
      wrapper,
    });
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    expect(result.current).toBeUndefined();
  });

  it('returns undefined while the profile query is pending', async () => {
    // Profile never resolves; strategies is available. The name guard keeps the
    // hook at undefined instead of matching against an absent strategy name.
    const wrapper = setUp((url) => {
      if (url.endsWith('/profiles/p1')) return new Promise<Response>(() => undefined);
      if (url.endsWith('/strategies')) return json([descriptor('2.0.0')]);
      return new Response('not found', { status: 404 });
    });
    const { result } = renderHook(() => useStrategyDescriptor(PROFILE_ID, { matchVersion: true }), {
      wrapper,
    });
    expect(result.current).toBeUndefined();
    // Stays undefined after the strategies query settles.
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(result.current).toBeUndefined();
  });

  it('returns undefined when no descriptor matches the profile strategy name', async () => {
    const wrapper = setUp((url) => {
      if (url.endsWith('/profiles/p1')) return json(profile('2.0.0'));
      if (url.endsWith('/strategies')) return json([{ ...descriptor('2.0.0'), name: 'momentum' }]);
      return new Response('not found', { status: 404 });
    });
    const { result } = renderHook(() => useStrategyDescriptor(PROFILE_ID), { wrapper });
    // Wait for both queries to settle, then confirm no match resolved.
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2));
    expect(result.current).toBeUndefined();
  });
});
