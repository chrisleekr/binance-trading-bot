// SymbolTickChips — per-profile Last tick + Latency chips on the symbol
// detail price strip. Pins three behaviours:
//   1. Hydrated values render in the two chips when the dashboard aggregate
//      lands in the query cache.
//   2. `lastTickAt === null` swaps the value text for the "awaiting first
//      tick" copy and renders the Configure API key link.
//   3. While the aggregate is still loading (or the profile is absent),
//      the component renders nothing — no layout thrash.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { SymbolTickChips } from '@/features/symbol/components/symbol-tick-chips';

import { pendingFetchForPaths } from './helpers/pending-fetch';

import type { DashboardAggregateResponse } from '@app/contracts';

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
// Matches the global test-setup default active account; the chips read the
// aggregate keyed by it and build the account-level api-key link from it.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const DASHBOARD_AGGREGATE_PATH = `/api/accounts/${ACCOUNT_ID}/dashboard-aggregate`;

const row = (
  overrides: Partial<DashboardAggregateResponse['profiles'][number]>,
): DashboardAggregateResponse['profiles'][number] => ({
  profileId: PROFILE_ID,
  name: 'btc-real',
  enabled: true,
  binanceMode: 'live',
  lastTickAt: null,
  lastTickLatencyMs: null,
  apiKeyConfigured: true,
  lastTickError: null,
  killSwitch: false,
  openOrderCount: 0,
  openOrders: [],
  openPositionCount: 0,
  positions: [],
  ...overrides,
});

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const setUp = (data: DashboardAggregateResponse | undefined, demoMode = false): void => {
  const queryClient = createQueryClient();
  // Bypass root loader auth gate. `demoMode` also decides whether the api-key link is offered.
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true, demoMode });
  if (data !== undefined) queryClient.setQueryData(['dashboard-aggregate', ACCOUNT_ID], data);

  const symbolStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/accounts/$accountId/profiles/$profileId/symbols/$symbol',
    component: () => <SymbolTickChips profileId={PROFILE_ID} />,
  });
  const apiKeyStub = stub('/accounts/$accountId/api-key');
  const onboardingStub = stub('/onboarding');
  const loginStub = stub('/login');

  const router = createRouter({
    routeTree: rootRoute.addChildren([symbolStub, apiKeyStub, onboardingStub, loginStub]),
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: [`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/symbols/BTCUSDT`],
    }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
};

// Pin the clock so formatLastTick tier boundaries are exact in assertions.
const NOW = new Date('2026-05-18T00:00:00.000Z');

beforeEach(() => {
  vi.stubGlobal('fetch', pendingFetchForPaths(DASHBOARD_AGGREGATE_PATH));
  // Only fake `Date`, not setTimeout/queueMicrotask — TanStack Router's
  // loader resolution needs real microtask scheduling. `toFake: ['Date']`
  // pins Date.now()/new Date() so formatLastTick tier boundaries are exact.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SymbolTickChips', () => {
  it('renders nothing while the dashboard aggregate is still loading', () => {
    setUp(undefined);
    expect(screen.queryByTestId('symbol-tick-chips')).toBeNull();
  });

  it('renders nothing when the profile id is not in the aggregate', () => {
    setUp({ profiles: [row({ profileId: '99999999-9999-4999-8999-999999999999' })] });
    expect(screen.queryByTestId('symbol-tick-chips')).toBeNull();
  });

  it('renders both chips with formatted values when the row has ticked', async () => {
    setUp({
      profiles: [
        row({
          lastTickAt: new Date(NOW.getTime() - 12_000).toISOString(),
          lastTickLatencyMs: 87,
        }),
      ],
    });
    expect(await screen.findByTestId('symbol-tick-chips')).toBeInTheDocument();
    expect(screen.getByTestId('symbol-tick-chip-last-tick')).toHaveTextContent('12s ago');
    expect(screen.getByTestId('symbol-tick-chip-latency')).toHaveTextContent('87 ms');
    expect(screen.queryByTestId('symbol-tick-chip-api-key-link')).toBeNull();
  });

  it('shows the latency chip (not the API-key link) when a key is bound but no tick yet', async () => {
    setUp({
      profiles: [
        row({
          name: 'btc-real',
          lastTickAt: null,
          lastTickLatencyMs: null,
          apiKeyConfigured: true,
        }),
      ],
    });
    const lastTick = await screen.findByTestId('symbol-tick-chip-last-tick');
    expect(lastTick).toHaveTextContent('awaiting first tick');
    // Link suppressed: the key is already configured; the previous behaviour
    // (link gated on lastTickAt === null) misled the operator into thinking
    // their bound key was missing.
    expect(screen.queryByTestId('symbol-tick-chip-api-key-link')).toBeNull();
    expect(screen.getByTestId('symbol-tick-chip-latency')).toBeInTheDocument();
  });

  it('shows the API-key link when the profile has no bound key', async () => {
    setUp({
      profiles: [
        row({
          name: 'btc-real',
          lastTickAt: null,
          lastTickLatencyMs: null,
          apiKeyConfigured: false,
        }),
      ],
    });
    const lastTick = await screen.findByTestId('symbol-tick-chip-last-tick');
    expect(lastTick).toHaveTextContent('awaiting first tick');
    const link = screen.getByTestId('symbol-tick-chip-api-key-link');
    expect(link).toHaveAttribute('href', `/accounts/${ACCOUNT_ID}/api-key`);
    expect(link).toHaveAttribute('aria-label', 'Set API key for profile btc-real');
    // Sibling of the chip span — a screen reader announces the chip and the
    // link separately, not as a single concatenated label.
    expect(lastTick.contains(link)).toBe(false);
    expect(screen.queryByTestId('symbol-tick-chip-latency')).toBeNull();
  });

  it('states the missing key without a link in the demo', async () => {
    // `GET /api-key` 403s for the demo operator, so the link goes; the same words stay as text, because "this profile has no key" is still the true and useful reading.
    setUp(
      {
        profiles: [
          row({
            name: 'btc-real',
            lastTickAt: null,
            lastTickLatencyMs: null,
            apiKeyConfigured: false,
          }),
        ],
      },
      true,
    );
    expect(await screen.findByTestId('symbol-tick-chip-api-key-hint')).toHaveTextContent(
      'Set API key if not configured',
    );
    expect(screen.queryByTestId('symbol-tick-chip-api-key-link')).toBeNull();
  });
});
