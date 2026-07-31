// HistoryPage — the per-profile History page (archive · audit · activity tabs).
// Replaced the HISTORY dock. Asserts the page chrome and tab switching; the
// individual panels have their own tests.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import {
  profileDetailIndexRoute,
  profileDetailRoute,
} from '@/features/profile/routes/profiles.$profileId';
import { historyRoute } from '@/features/profile/routes/profiles.$profileId.history';

const PROFILE_ID = '00000000-0000-4000-8000-0000000000a1';
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const setUp = (initialPath?: string): ReturnType<typeof createRouter> => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ),
  );
  const queryClient = createQueryClient();
  // Sidestep the onboarding redirect so the page renders.
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub('/'),
      stub('/onboarding'),
      stub('/login'),
      accountScopeRoute.addChildren([
        profileDetailRoute.addChildren([profileDetailIndexRoute, historyRoute]),
      ]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: [initialPath ?? `/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/history`],
    }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return router;
};

describe('HistoryPage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the History header and the three tabs, archive active by default', async () => {
    setUp();
    expect(await screen.findByRole('heading', { name: /^history$/i })).toBeInTheDocument();
    expect(screen.getByTestId('history-tab-archive')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('history-tab-audit')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('history-tab-activity')).toBeInTheDocument();
  });

  it('switches to the Activity tab on click', async () => {
    setUp();
    await screen.findByTestId('history-tab-activity');
    await userEvent.click(screen.getByTestId('history-tab-activity'));
    expect(screen.getByTestId('history-tab-activity')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('history-tab-archive')).toHaveAttribute('aria-selected', 'false');
    // The activity feed mounts (it renders its root regardless of data).
    expect(await screen.findByTestId('activity-feed')).toBeInTheDocument();
  });

  it('switches to the Audit tab on click', async () => {
    setUp();
    await screen.findByTestId('history-tab-audit');
    await userEvent.click(screen.getByTestId('history-tab-audit'));
    expect(screen.getByTestId('history-tab-audit')).toHaveAttribute('aria-selected', 'true');
  });

  it('clicking a tab writes it to the URL, so the view is linkable', async () => {
    // Asserted on router state, not window.location: the test router uses a
    // memory history, which never touches the address bar.
    const router = setUp();
    await screen.findByTestId('history-tab-activity');
    await userEvent.click(screen.getByTestId('history-tab-activity'));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ section: 'activity' }),
    );
  });

  it('?section= opens that tab directly, without a click', async () => {
    setUp(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/history?section=audit`);
    await screen.findByTestId('history-tab-audit');
    expect(screen.getByTestId('history-tab-audit')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('history-tab-archive')).toHaveAttribute('aria-selected', 'false');
  });

  it('an unknown ?section= falls back to the default tab, leaving no tab unselected', async () => {
    setUp(`/accounts/${ACCOUNT_ID}/profiles/${PROFILE_ID}/history?section=nope`);
    // Regression guard: TanStack merges the parent match's raw search over this
    // route's validated output, so `section=nope` does reach the component. Read
    // -site validation is what keeps every tab from rendering unselected.
    expect(await screen.findByRole('heading', { name: /^history$/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('history-tab-archive')).toHaveAttribute('aria-selected', 'true'),
    );
  });
});
