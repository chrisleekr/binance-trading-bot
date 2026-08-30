// The routed suite owns the settings-to-archive boundary because the provider and panel meet here. Panel-only archive behavior stays in trade-archive-panel.test.tsx.

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

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

type FetchResponder = (url: string, init?: RequestInit) => Response | Promise<Response>;

/**
 * Isolates full archive traffic from the route shell's unrelated requests so timing assertions cannot pass on aggregate fetch counts.
 * @param fetchMock - The route-level fetch mock whose calls include settings, shell, and archive requests.
 * @returns Parsed URLs for full-view archive requests belonging to the test profile.
 */
const fullArchiveRequests = (fetchMock: ReturnType<typeof vi.fn>): URL[] =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter(
      (url) =>
        url.pathname.endsWith(`/profiles/${PROFILE_ID}/trade-archive`) &&
        url.searchParams.get('view') === 'full',
    );

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

/**
 * Mounts the real provider-to-panel boundary so request-order tests share the production query state.
 * @param initialPath - Optional route URL, defaulting to the test profile's History page.
 * @param responder - Per-request response factory used to delay or fail settings independently of other route data.
 * @returns The configured router rendered through the shared query provider.
 */
const setUp = (
  initialPath?: string,
  responder: FetchResponder = () => json({}),
): ReturnType<typeof createRouter> => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
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

  it('renders the History header and every tab, archive active by default', async () => {
    setUp();
    expect(await screen.findByRole('heading', { name: /^history$/i })).toBeInTheDocument();
    expect(screen.getByTestId('history-tab-archive')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('history-tab-audit')).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('history-tab-logs')).toBeInTheDocument();
    expect(screen.getByTestId('history-tab-activity')).toBeInTheDocument();
  });

  it('does not request the full archive while display settings are unresolved', async () => {
    const settings = new Promise<Response>(() => undefined);
    setUp(undefined, (url) => (url.includes('/account/settings') ? settings : json({})));

    expect(await screen.findByRole('heading', { name: /^history$/i })).toBeInTheDocument();
    const fetchMock = vi.mocked(fetch);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes('/account/settings')),
      ).toBe(true),
    );
    expect(fullArchiveRequests(fetchMock)).toHaveLength(0);
  });

  it('makes one initial full-archive request in the resolved display timezone', async () => {
    let resolveSettings: (response: Response) => void = () => undefined;
    const settings = new Promise<Response>((resolve) => {
      resolveSettings = resolve;
    });
    setUp(undefined, (url) => (url.includes('/account/settings') ? settings : json({})));

    expect(await screen.findByRole('heading', { name: /^history$/i })).toBeInTheDocument();
    const fetchMock = vi.mocked(fetch);
    expect(fullArchiveRequests(fetchMock)).toHaveLength(0);

    resolveSettings(json({ timezone: 'Australia/Sydney' }));
    await waitFor(() => expect(fullArchiveRequests(fetchMock)).toHaveLength(1));
    expect(fullArchiveRequests(fetchMock).map((url) => url.searchParams.get('tz'))).toEqual([
      'Australia/Sydney',
    ]);
  });

  it('shows a settings error and keeps the archive disabled when display settings fail', async () => {
    setUp(undefined, (url) =>
      url.includes('/account/settings')
        ? new Response('', { status: 503, statusText: 'settings unavailable' })
        : json({}),
    );

    const fetchMock = vi.mocked(fetch);
    await waitFor(() => {
      expect(screen.getByText(/could not load.*settings/i)).toBeInTheDocument();
      expect(fullArchiveRequests(fetchMock)).toHaveLength(0);
    });
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

  it('switches to the Logs tab on click, mounting the log viewer', async () => {
    setUp();
    await screen.findByTestId('history-tab-logs');
    await userEvent.click(screen.getByTestId('history-tab-logs'));
    expect(screen.getByTestId('history-tab-logs')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('log-viewer')).toBeInTheDocument();
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
