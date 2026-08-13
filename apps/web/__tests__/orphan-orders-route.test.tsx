import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { rootRoute } from '@/app/__root';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { orphanOrdersRoute } from '@/features/account/routes/account.orphan-orders';

const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const TEST_ACCOUNT = {
  id: ACCOUNT_ID,
  name: 'Main',
  binanceMode: 'test' as const,
  apiKeyConfigured: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
  Toaster: () => null,
}));

const P1 = '00000000-0000-4000-8000-000000000001';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const orphan = (over: Record<string, unknown> = {}) => ({
  orderId: '10',
  accountId: ACCOUNT_ID,
  symbol: 'BTCUSDT',
  side: 'BUY',
  type: 'LIMIT',
  price: '60000',
  origQty: '0.001',
  status: 'NEW',
  clientOrderId: 'tt-abc10-b',
  timeMs: 1_700_000_000_000,
  mode: 'live',
  ownerProfileId: P1,
  ownerProfileName: 'Alpha',
  ...over,
});

const listBody = {
  computedAtMs: 1_700_000_000_000,
  orphans: [
    orphan(),
    // An order NO profile can prove it placed: not adoptable at all.
    orphan({
      orderId: '20',
      symbol: 'ETHUSDT',
      side: 'BUY',
      price: '3000',
      origQty: '0.5',
      clientOrderId: 'someone-elses-order',
      ownerProfileId: null,
      ownerProfileName: null,
    }),
    // A SELL still resting on the book that NO profile can claim (its profile was
    // deleted). It is holding the operator's coins and nothing can take it over.
    orphan({
      orderId: '30',
      symbol: 'ENAUSDT',
      side: 'SELL',
      type: 'STOP_LOSS_LIMIT',
      price: '0.27',
      origQty: '189.87',
      status: 'NEW',
      clientOrderId: 'mo-dead-profile-ps',
      ownerProfileId: null,
      ownerProfileName: null,
    }),
    // A resting SELL that its OWNER still claims — an orphaned protective stop.
    // Adoptable, and it must stay so: the owner recognises its own id.
    orphan({
      orderId: '40',
      symbol: 'SOLUSDT',
      side: 'SELL',
      type: 'STOP_LOSS_LIMIT',
      price: '120',
      origQty: '2',
      status: 'NEW',
      clientOrderId: 'mo-abc40-ps',
    }),
  ],
};

const setUp = (responder: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  queryClient.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  queryClient.setQueryData(['accounts'], [TEST_ACCOUNT]);
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub('/'),
      stub('/onboarding'),
      stub('/login'),
      stub('/account'),
      accountScopeRoute.addChildren([orphanOrdersRoute]),
    ]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/accounts/${ACCOUNT_ID}/orphan-orders`] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
  return { fetchMock, ...utils };
};

describe('OrphanOrdersPage', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('names the profile that PLACED the order — and offers no picker at all', async () => {
    // The picker is the bug. An operator who can choose the destination can choose
    // wrong, and choosing wrong hands one strategy's resting order to another,
    // which locks the base asset against its true owner forever.
    setUp((url) => {
      if (url.endsWith('/orphan-orders')) return json(listBody);
      return json({}, 404);
    });
    expect(await screen.findByText('BTCUSDT', undefined, { timeout: 5000 })).toBeInTheDocument();
    const row = screen.getByTestId('orphan-live:10');
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).getByText(/Placed by/i)).toBeInTheDocument();
    expect(within(row).getByText('Alpha')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /adopt/i })).toBeEnabled();
  });

  it('shows the empty state when nothing is orphaned', async () => {
    setUp((url) => {
      if (url.endsWith('/orphan-orders')) return json({ computedAtMs: null, orphans: [] });
      return json({}, 404);
    });
    expect(await screen.findByText(/No orphan orders/i)).toBeInTheDocument();
    // computedAtMs null renders the "never scanned" line, not a date.
    expect(screen.getByText(/Not checked yet/i)).toBeInTheDocument();
  });

  it('an order no profile placed is NOT adoptable: cancel-on-Binance or leave it', async () => {
    // There is no picker to fall back on, because there is no safe destination.
    // Saying so plainly is the whole point — the old page's answer was "choose
    // someone", which is how a trailing-trade stop ended up in a momentum profile.
    setUp((url) => {
      if (url.endsWith('/orphan-orders')) return json(listBody);
      return json({}, 404);
    });
    const row = await screen.findByTestId('orphan-live:20', undefined, { timeout: 5000 });
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /adopt/i })).not.toBeInTheDocument();
    expect(
      within(row).getByText(/No profile on this account placed this order/i),
    ).toBeInTheDocument();
    expect(within(row).getByText(/cancel it on Binance/i)).toBeInTheDocument();
  });

  it('hands an order back to its owner and removes it from the list', async () => {
    let body: unknown;
    setUp(async (url, init) => {
      if (init?.method === 'POST' && url.endsWith('/orphan-orders/adopt')) {
        body = JSON.parse(String(init.body ?? '{}'));
        return json({ id: 'row1', symbol: 'BTCUSDT', profileId: P1, binanceOrderId: '10' }, 201);
      }
      if (url.endsWith('/orphan-orders')) return json(listBody);
      return json({}, 404);
    });
    const user = userEvent.setup();
    const row = await screen.findByTestId('orphan-live:10');
    await user.click(within(row).getByRole('button', { name: /adopt/i }));
    await user.click(await screen.findByRole('button', { name: /confirm adopt/i }));
    // No profileId on the wire: the server derives it. A client that could name a
    // destination could name the wrong one.
    await waitFor(() => expect(body).toEqual({ orderId: '10', mode: 'live' }));
    // Adopted order leaves the list; the un-adoptable one stays.
    await waitFor(() => expect(screen.queryByTestId('orphan-live:10')).not.toBeInTheDocument());
    expect(screen.getByTestId('orphan-live:20')).toBeInTheDocument();
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        expect.stringMatching(/Handed BTCUSDT back to Alpha/i),
      ),
    );
  });

  it('surfaces an adopt failure and keeps the order in the list', async () => {
    setUp(async (url, init) => {
      if (init?.method === 'POST' && url.endsWith('/orphan-orders/adopt')) {
        return json({ error: { code: 'CONFLICT', message: 'order is already adopted' } }, 409);
      }
      if (url.endsWith('/orphan-orders')) return json(listBody);
      return json({}, 404);
    });
    const user = userEvent.setup();
    const row = await screen.findByTestId('orphan-live:10');
    await user.click(within(row).getByRole('button', { name: /adopt/i }));
    await user.click(await screen.findByRole('button', { name: /confirm adopt/i }));
    // The adopt failure closes the dialog and surfaces the reason as a toast;
    // the order stays in the list because only a success removes it.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/already adopted/i)),
    );
    expect(screen.getByTestId('orphan-live:10')).toBeInTheDocument();
  });

  it('refuses adoption for an UNCLAIMED resting SELL that is holding the coins', async () => {
    // The -2010 storm's entry point, and the case master's guard is really about:
    // nothing can take this order over, so while it rests the base stays locked and
    // whoever owns the coins cannot fund a protective stop for them. The api 409s
    // it; the page says so rather than making the operator hit the error.
    setUp((url) => {
      if (url.endsWith('/orphan-orders')) return json(listBody);
      return json({}, 404);
    });
    const row = await screen.findByTestId('orphan-live:30', undefined, { timeout: 5000 });
    expect(within(row).queryByRole('button', { name: /adopt/i })).not.toBeInTheDocument();
    expect(row).toHaveTextContent(/holding your coins/i);

    // A resting BUY locks quote, not coins, and stays adoptable.
    const buyRow = screen.getByTestId('orphan-live:10');
    expect(within(buyRow).getByRole('button', { name: /adopt/i })).toBeInTheDocument();
  });

  it('STILL offers adoption for a resting SELL its owner claims (an orphaned stop)', async () => {
    // The composed rule. A blanket resting-SELL refusal would make an orphaned
    // protective stop — which IS a resting SELL — permanently un-adoptable, gutting
    // "an orphan goes back to the profile that placed it". Handing it to its TRUE
    // owner is safe by construction: that strategy matches its own deterministic
    // clientOrderId, so it will not place a duplicate and does not see the order as
    // foreign. The base being locked by the profile's OWN stop is the correct
    // protected state, not a fault.
    setUp((url) => {
      if (url.endsWith('/orphan-orders')) return json(listBody);
      return json({}, 404);
    });
    const row = await screen.findByTestId('orphan-live:40', undefined, { timeout: 5000 });
    expect(within(row).getByRole('button', { name: /adopt/i })).toBeInTheDocument();
    expect(row).not.toHaveTextContent(/holding your coins/i);
  });
});
