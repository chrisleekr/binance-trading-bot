// AddSymbolPanel — searchable picker over Binance's exchange-info, rendered as
// the body of the `/profiles/:id/symbols/new` route page. Renders the
// TRADING-status list, POSTs the chosen symbol to /profiles/:id/symbols, and on
// success invalidates the profile dashboard read and navigates back to the
// overview (`/`). The CONFLICT mapping is the load-bearing operator-guidance
// case. fetch is mocked.

import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { AddSymbolPanel } from '@/features/symbol/components/add-symbol-panel';

const toastError = vi.fn();
const toastWarning = vi.fn();
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: (m: string) => toastError(m),
    warning: (m: string) => toastWarning(m),
  },
}));

const PROFILE_ID = '00000000-0000-4000-8000-000000000001';

type Json = unknown;

const json = (body: Json, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const exchangeInfo = {
  symbols: [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      status: 'TRADING',
      filterTickSize: '0.01000000',
    },
    {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      status: 'TRADING',
      filterTickSize: '0.01000000',
    },
    {
      symbol: 'BREAKUSDT',
      baseAsset: 'BREAK',
      quoteAsset: 'USDT',
      status: 'BREAK',
      filterTickSize: null,
    },
  ],
  fetchedAt: '2026-05-10T00:00:00.000Z',
  technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy' },
};

// Render the panel on its real route. A successful add navigates to `/`, so the
// router's pathname is the observable: it leaves the add-symbol page on success
// and stays put on failure.
const ADD_PATH = `/profiles/${PROFILE_ID}/symbols/new`;
const setUp = (
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fetchMock: ReturnType<typeof vi.fn>; router: ReturnType<typeof createRouter> } => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);

  const queryClient = createQueryClient();
  const root = createRootRoute({ component: () => <Outlet /> });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/',
        component: () => <div data-testid="overview" />,
      }),
      createRoute({
        getParentRoute: () => root,
        path: '/profiles/$profileId/symbols/new',
        component: () => <AddSymbolPanel profileId={PROFILE_ID} />,
      }),
    ]),
    context: {},
    history: createMemoryHistory({ initialEntries: [ADD_PATH] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, router };
};

// `restoreAllMocks` does not clear call history on a module-scope `vi.fn()`, so
// without this the spies accumulate across cases and any negative assertion
// would be reading another test's calls.
beforeEach(() => {
  toastError.mockClear();
  toastWarning.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('<AddSymbolPanel>', () => {
  it('renders only TRADING-status symbols from the cached exchange-info', async () => {
    setUp((url) => {
      if (url.endsWith('/exchange-info')) return json(exchangeInfo);
      throw new Error(`unexpected ${url}`);
    });

    const list = await screen.findByTestId('symbols-new-list', {}, { timeout: 5000 });
    // The picker is boxed in the shared Panel with its own section title.
    expect(screen.getByRole('heading', { name: 'Choose a symbol' })).toBeInTheDocument();
    expect(within(list).getByText('BTCUSDT')).toBeInTheDocument();
    expect(within(list).getByText('ETHUSDT')).toBeInTheDocument();
    // BREAK status is filtered out.
    expect(within(list).queryByText('BREAKUSDT')).not.toBeInTheDocument();
  });

  it('POSTs the chosen symbol then returns to the overview', async () => {
    const { fetchMock, router } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/exchange-info') && method === 'GET') return json(exchangeInfo);
      if (url.endsWith(`/profiles/${PROFILE_ID}/symbols`) && method === 'POST')
        return json({ symbol: 'BTCUSDT', overrideConfig: null, source: 'manual' }, 201);
      throw new Error(`unexpected ${method} ${url}`);
    });

    const list = await screen.findByTestId('symbols-new-list', {}, { timeout: 5000 });
    await userEvent.click(within(list).getByLabelText('BTCUSDT'));
    await userEvent.click(screen.getByRole('button', { name: 'Add symbol' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit)?.method === 'POST',
      );
      if (!postCall) throw new Error('expected a POST call');
      const body = JSON.parse((postCall[1] as RequestInit).body as string) as { symbol: string };
      expect(body.symbol).toBe('BTCUSDT');
    });

    // The page leaves on success: navigation lands back on the overview.
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('includes the entered average entry price in the POST body (#496)', async () => {
    const { fetchMock } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/exchange-info') && method === 'GET') return json(exchangeInfo);
      if (url.endsWith(`/profiles/${PROFILE_ID}/symbols`) && method === 'POST')
        return json({ symbol: 'BTCUSDT', overrideConfig: null, source: 'manual' }, 201);
      throw new Error(`unexpected ${method} ${url}`);
    });

    const list = await screen.findByTestId('symbols-new-list', {}, { timeout: 5000 });
    await userEvent.click(within(list).getByLabelText('BTCUSDT'));
    await userEvent.type(screen.getByTestId('add-symbol-entry-price'), '42000');
    await userEvent.click(screen.getByRole('button', { name: 'Add symbol' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit)?.method === 'POST',
      );
      if (!postCall) throw new Error('expected a POST call');
      const body = JSON.parse((postCall[1] as RequestInit).body as string) as {
        symbol: string;
        avgEntryPrice?: string;
      };
      expect(body.symbol).toBe('BTCUSDT');
      expect(body.avgEntryPrice).toBe('42000');
    });
  });

  it('omits avgEntryPrice when the entry-price field is left blank', async () => {
    const { fetchMock } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/exchange-info') && method === 'GET') return json(exchangeInfo);
      if (url.endsWith(`/profiles/${PROFILE_ID}/symbols`) && method === 'POST')
        return json({ symbol: 'BTCUSDT', overrideConfig: null, source: 'manual' }, 201);
      throw new Error(`unexpected ${method} ${url}`);
    });

    const list = await screen.findByTestId('symbols-new-list', {}, { timeout: 5000 });
    await userEvent.click(within(list).getByLabelText('BTCUSDT'));
    await userEvent.click(screen.getByRole('button', { name: 'Add symbol' }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit)?.method === 'POST',
      );
      if (!postCall) throw new Error('expected a POST call');
      const body = JSON.parse((postCall[1] as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      // Key must be absent (not present-and-undefined) so the contract's
      // `.optional()` path is exercised, not a JSON `null`/`undefined` hole.
      expect(body).not.toHaveProperty('avgEntryPrice');
    });
  });

  it('shows a banner and does not POST when the entry price is not a positive number', async () => {
    const { fetchMock } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/exchange-info') && method === 'GET') return json(exchangeInfo);
      if (url.endsWith(`/profiles/${PROFILE_ID}/symbols`) && method === 'POST')
        return json({ symbol: 'BTCUSDT', overrideConfig: null, source: 'manual' }, 201);
      throw new Error(`unexpected ${method} ${url}`);
    });

    const list = await screen.findByTestId('symbols-new-list', {}, { timeout: 5000 });
    await userEvent.click(within(list).getByLabelText('BTCUSDT'));
    await userEvent.type(screen.getByTestId('add-symbol-entry-price'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Add symbol' }));

    // A typo surfaces a clear error toast (not a dead button or a thrown
    // DecimalError) and never fires the POST.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/positive number/i)),
    );
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit)?.method === 'POST')).toBe(
      false,
    );
  });

  it('maps a CONFLICT response to the already-on-this-profile message', async () => {
    const { router } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/exchange-info') && method === 'GET') return json(exchangeInfo);
      if (url.endsWith(`/profiles/${PROFILE_ID}/symbols`) && method === 'POST')
        return json({ error: { code: 'CONFLICT', message: 'symbol already in profile' } }, 409);
      throw new Error(`unexpected ${method} ${url}`);
    });

    const list = await screen.findByTestId('symbols-new-list', {}, { timeout: 5000 });
    await userEvent.click(within(list).getByLabelText('BTCUSDT'));
    await userEvent.click(screen.getByRole('button', { name: 'Add symbol' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('That symbol is already on this profile.'),
    );
    // A failed add must stay on the page so the operator can retry.
    expect(router.state.location.pathname).toBe(ADD_PATH);
  });

  it('warns when the bind went through but its order sizing was not verified', async () => {
    const { router } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/exchange-info') && method === 'GET') return json(exchangeInfo);
      if (url.endsWith(`/profiles/${PROFILE_ID}/symbols`) && method === 'POST')
        return json(
          {
            symbol: 'BTCUSDT',
            overrideConfig: null,
            source: 'manual',
            diagnostics: [
              {
                level: 'warn',
                code: 'filters-unavailable',
                message: 'BTCUSDT: trading rules have not loaded yet.',
              },
            ],
          },
          201,
        );
      throw new Error(`unexpected ${method} ${url}`);
    });

    const list = await screen.findByTestId('symbols-new-list', {}, { timeout: 5000 });
    await userEvent.click(within(list).getByLabelText('BTCUSDT'));
    await userEvent.click(screen.getByRole('button', { name: 'Add symbol' }));

    await waitFor(() =>
      expect(toastWarning).toHaveBeenCalledWith('BTCUSDT: trading rules have not loaded yet.'),
    );
    // The advisory does not undo the add, so the operator still lands back on
    // the overview. A toast is the only surface that survives that navigation.
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('says nothing extra when the bind was fully verified', async () => {
    const { router } = setUp((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/exchange-info') && method === 'GET') return json(exchangeInfo);
      if (url.endsWith(`/profiles/${PROFILE_ID}/symbols`) && method === 'POST')
        return json({ symbol: 'BTCUSDT', overrideConfig: null, source: 'manual' }, 201);
      throw new Error(`unexpected ${method} ${url}`);
    });

    const list = await screen.findByTestId('symbols-new-list', {}, { timeout: 5000 });
    await userEvent.click(within(list).getByLabelText('BTCUSDT'));
    await userEvent.click(screen.getByRole('button', { name: 'Add symbol' }));

    // Wait for the success path to complete before asserting the absence, so
    // this cannot pass merely by checking too early.
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(toastWarning).not.toHaveBeenCalled();
  });
});
