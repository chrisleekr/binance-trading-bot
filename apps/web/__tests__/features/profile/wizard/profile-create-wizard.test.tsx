import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { profileNewRoute } from '@/features/profile/routes/profiles.new';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { accountsQueryKey } from '@/features/account/api/accounts';
import { rootRoute } from '@/app/__root';

type Json = Record<string, unknown>;

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

const json = (body: Json | Json[], status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

interface RouteHandler {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
}

const setUp = (handlers: RouteHandler[]) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const h of handlers) {
      if (h.match(url, init)) return h.respond(url, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  // Bypass root onboarding redirect.
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  // Seed the account list so the `/accounts/$accountId` scope guard passes
  // without a fetch and sets the active account before children load.
  queryClient.setQueryData(accountsQueryKey, [{ id: ACCOUNT_ID, name: 'main' }]);
  const indexStub = stub('/');
  const loginStub = stub('/login');
  const onboardingStub = stub('/onboarding');
  // The wizard lands the operator on the profile's config page after creating.
  const profileConfigStub = createRoute({
    getParentRoute: () => accountScopeRoute,
    path: '/profiles/$profileId/config',
    component: () => <div data-testid="profile-config-page" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexStub,
      onboardingStub,
      loginStub,
      accountScopeRoute.addChildren([profileNewRoute, profileConfigStub]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/accounts/${ACCOUNT_ID}/profiles/new`] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, queryClient, router, ...utils };
};

const wizardConfigSchema = {
  type: 'object' as const,
  properties: {
    symbol: { type: 'string' },
    buy: { type: 'object', properties: { enabled: { type: 'boolean' } } },
  },
};

const strategyDescriptor = {
  name: 'trailing-trade',
  version: '2.0.0',
  displayName: 'Trailing Trade',
  description: 'Grid-trade + stop-loss + Technicals gating + manual overrides.',
  // configSchema is kept only to satisfy the StrategyDescriptor shape; the
  // wizard no longer renders a config form. `defaultConfig` is what the create
  // POST forwards.
  configSchema: wizardConfigSchema,
  overrideConfigSchema: wizardConfigSchema,
  defaultConfig: { symbol: 'BTCUSDT', buy: { enabled: true } },
  operatorActions: [],
};

const unknownStrategyDescriptor = {
  name: 'unknown-strategy',
  version: '0.0.1',
  displayName: 'Unknown Strategy',
  description: 'A second strategy fixture, distinct from trailing-trade.',
  configSchema: wizardConfigSchema,
  overrideConfigSchema: wizardConfigSchema,
  defaultConfig: {},
  operatorActions: [],
};

const strategiesHandler = (descriptors: Json[]): RouteHandler => ({
  match: (url) => url.includes('/api/strategies'),
  respond: () => json(descriptors),
});

const profileResponse = (overrides: Partial<Json> = {}): Json => ({
  id: '11111111-1111-4111-8111-111111111111',
  accountId: ACCOUNT_ID,
  name: 'btc-grid',
  strategyName: 'trailing-trade',
  strategyVersion: '2.0.0',
  config: {},
  enabled: false,
  binanceMode: 'test',
  quoteAsset: 'USDT',
  createdAt: '2026-05-09T10:00:00.000Z',
  updatedAt: '2026-05-09T10:00:00.000Z',
  ...overrides,
});

describe('Profile create wizard', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders step 1 with progress indicator', async () => {
    setUp([strategiesHandler([strategyDescriptor])]);
    expect(await screen.findByTestId('wizard-step-1')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar');
    expect(progress).toHaveAttribute('aria-valuenow', '1');
    expect(progress).toHaveAttribute('aria-valuemax', '2');
  });

  it('blocks Next on step 1 without a name', async () => {
    setUp([strategiesHandler([strategyDescriptor])]);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('wizard-next'));
    expect(await screen.findByText(/profile name is required/i)).toBeInTheDocument();
    expect(screen.getByTestId('wizard-step-1')).toBeInTheDocument();
  });

  it(
    'walks name → strategy and POSTs the profile with the strategy default config',
    // The heaviest test in the suite: a full wizard walk with many async `findBy`
    // + user-event interactions. It runs in ~3.5s locally but has timed out at
    // 15s under parallel CI load; 30s gives generous headroom.
    { timeout: 30000 },
    async () => {
      const fetches: { url: string; init?: RequestInit }[] = [];
      setUp([
        strategiesHandler([strategyDescriptor]),
        {
          match: (url, init) =>
            url.includes('/profiles') &&
            !url.includes('/symbols') &&
            !url.includes('/profiles/new') &&
            init?.method === 'POST',
          respond: (url, init) => {
            fetches.push({ url, init });
            return json(profileResponse(), 201);
          },
        },
      ]);
      const user = userEvent.setup();

      // Step 1
      await user.type(await screen.findByLabelText(/profile name/i), 'btc-grid');
      await user.click(screen.getByTestId('wizard-next'));

      // Step 2 (final): pick the (only) strategy; confirming creates the profile
      // with the strategy default config — no config or symbols step. Uses a
      // strategy with a NON-EMPTY defaultConfig so the forwarding is observable.
      await screen.findByTestId('wizard-step-2');
      await user.click(await screen.findByTestId('wizard-strategy-trailing-trade'));
      await user.click(screen.getByTestId('wizard-next'));

      await waitFor(
        () => {
          expect(
            fetches.filter((f) => f.url.includes('/profiles') && !f.url.includes('/symbols')),
          ).toHaveLength(1);
        },
        { timeout: 5000 },
      );

      // The wizard never posts symbols anymore.
      expect(fetches.filter((f) => f.url.includes('/symbols'))).toHaveLength(0);

      // Profile create is account-scoped: the request path carries the account.
      expect(fetches[0]?.url).toContain(`/accounts/${ACCOUNT_ID}/profiles`);
      const profileBody = JSON.parse(String(fetches[0]?.init?.body));
      expect(profileBody).toMatchObject({
        name: 'btc-grid',
        strategyName: 'trailing-trade',
        strategyVersion: '2.0.0',
      });
      // The create forwards the strategy's default config verbatim (strict match,
      // not a subset — a dropped or mangled config must fail here).
      expect(profileBody.config).toEqual(strategyDescriptor.defaultConfig);

      // Lands on the profile's config page to tune the defaults.
      await waitFor(() => {
        expect(screen.getByTestId('profile-config-page')).toBeInTheDocument();
      });
    },
  );

  it(
    'creates at most one profile when the strategy step is double-submitted',
    { timeout: 15_000 },
    async () => {
      const fetches: { url: string }[] = [];
      setUp([
        strategiesHandler([unknownStrategyDescriptor]),
        {
          match: (url, init) =>
            url.includes('/profiles') &&
            !url.includes('/symbols') &&
            !url.includes('/profiles/new') &&
            init?.method === 'POST',
          respond: (url) => {
            fetches.push({ url });
            return json(profileResponse(), 201);
          },
        },
      ]);
      const user = userEvent.setup();
      await user.type(await screen.findByLabelText(/profile name/i), 'btc-grid');
      await user.click(screen.getByTestId('wizard-next'));
      await user.click(await screen.findByTestId('wizard-strategy-unknown-strategy'));
      await screen.findByTestId('wizard-step-2');

      // Two synchronous clicks, before the async `creating` flag can disable the
      // button — the re-entrancy guard must collapse them to a single create.
      const createButton = screen.getByTestId('wizard-next');
      fireEvent.click(createButton);
      fireEvent.click(createButton);

      await waitFor(() => {
        expect(screen.getByTestId('profile-config-page')).toBeInTheDocument();
      });
      expect(
        fetches.filter((f) => f.url.includes('/profiles') && !f.url.includes('/symbols')),
      ).toHaveLength(1);
    },
  );

  it('admits a retry after a failed create (the guard resets)', { timeout: 15_000 }, async () => {
    let attempts = 0;
    const posts: string[] = [];
    setUp([
      strategiesHandler([unknownStrategyDescriptor]),
      {
        match: (url, init) =>
          url.includes('/profiles') &&
          !url.includes('/symbols') &&
          !url.includes('/profiles/new') &&
          init?.method === 'POST',
        respond: (url) => {
          posts.push(url);
          attempts += 1;
          return attempts === 1
            ? json({ error: { code: 'VALIDATION_FAILED', message: 'bad config' } }, 422)
            : json(profileResponse(), 201);
        },
      },
    ]);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/profile name/i), 'btc-grid');
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(await screen.findByTestId('wizard-strategy-unknown-strategy'));
    await screen.findByTestId('wizard-step-2');

    // First submit fails; the re-entrancy guard must release so a retry works.
    await user.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('wizard-error')).toBeInTheDocument();
    expect(posts).toHaveLength(1);

    // Second submit is admitted (guard reset in finally) and succeeds.
    await user.click(screen.getByTestId('wizard-next'));
    await waitFor(() => {
      expect(screen.getByTestId('profile-config-page')).toBeInTheDocument();
    });
    expect(posts).toHaveLength(2);
  });

  it('Back navigation preserves step 1 inputs', async () => {
    setUp([strategiesHandler([unknownStrategyDescriptor])]);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/profile name/i), 'btc-grid');
    await user.click(screen.getByTestId('wizard-next'));
    await screen.findByTestId('wizard-step-2');
    await user.click(screen.getByTestId('wizard-back'));
    const nameInput = await screen.findByLabelText(/profile name/i);
    expect(nameInput).toHaveValue('btc-grid');
  });

  it('surfaces a generic error on POST /profiles failure', { timeout: 15_000 }, async () => {
    setUp([
      strategiesHandler([unknownStrategyDescriptor]),
      {
        match: (url, init) =>
          url.includes('/profiles') &&
          !url.includes('/symbols') &&
          !url.includes('/profiles/new') &&
          init?.method === 'POST',
        respond: () => json({ error: { code: 'VALIDATION_FAILED', message: 'bad config' } }, 422),
      },
    ]);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/profile name/i), 'btc-grid');
    await user.click(screen.getByTestId('wizard-next'));
    await user.click(await screen.findByTestId('wizard-strategy-unknown-strategy'));
    // Step 2 (final): confirming the strategy triggers the failing POST /profiles.
    await screen.findByTestId('wizard-step-2');
    await user.click(screen.getByTestId('wizard-next'));
    expect(await screen.findByTestId('wizard-error')).toBeInTheDocument();
  });
});
