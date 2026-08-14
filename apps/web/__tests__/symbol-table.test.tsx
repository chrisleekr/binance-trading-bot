// SymbolTable — the account-wide flat symbol list on Home. Fans out one
// per-profile dashboard fetch, flattens the symbols, and renders one
// single-click row each. Covers merge/sort, filter, partial-load flag (one
// profile failing must not blank the list), and the per-row navigation link.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolTable } from '@/features/dashboard/components/symbol-table';
import { rootRoute } from '@/app/__root';

import type { DashboardAggregateResponse, ProfileDashboardResponse } from '@app/contracts';

type Row = DashboardAggregateResponse['profiles'][number];
type Sym = ProfileDashboardResponse['symbols'][number];

// Matches the global test-setup default active account; row links are built
// account-nested from useActiveAccountId.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';

const row = (profileId: string, name: string): Row => ({
  profileId,
  name,
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
});

const sym = (overrides: Partial<Sym> & { symbol: string }): Sym => ({
  enabled: true,
  avgEntryPrice: null,
  currentPrice: null,
  quantity: null,
  openOrderCount: 0,
  openOrders: [],
  entryBlocker: null,
  protectiveStopBlocker: null,
  ...overrides,
});

// profileId is a valid uuid because ProfileDashboardResponse parses it via z.uuid().
const dashboard = (symbols: Sym[]): ProfileDashboardResponse => ({
  profileId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  enabled: true,
  binanceMode: 'live',
  balances: [],
  totalProfit: '0',
  enabledNotifierCount: 0,
  symbols,
  cachedAt: '2026-06-04T00:00:00.000Z',
});

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const stub = (path: string) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

const renderTable = (
  rows: Row[],
  responder: (url: string) => Response,
  initialEntry = '/',
): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return responder(url);
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const symbolStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/profiles/$profileId/symbols/$symbol',
    component: () => <div data-testid="symbol-page" />,
  });
  const symbolConfigStub = createRoute({
    getParentRoute: () => rootRoute,
    path: '/profiles/$profileId/symbols/$symbol/config',
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/',
        component: () => <SymbolTable rows={rows} />,
      }),
      stub('/onboarding'),
      stub('/login'),
      symbolStub,
      symbolConfigStub,
    ]),
    context: { queryClient: qc },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  qc.setQueryData(['auth', 'onboarding-status'], { masterExists: true });
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider
        router={router as unknown as Parameters<typeof RouterProvider>[0]['router']}
      />
    </QueryClientProvider>,
  );
};

afterEach(() => vi.unstubAllGlobals());

describe('<SymbolTable>', () => {
  it('flattens symbols across profiles into one sorted, clickable list', async () => {
    renderTable([row('pa', 'alpha'), row('pb', 'bravo')], (url) =>
      url.includes('/profiles/pa/dashboard')
        ? json(dashboard([sym({ symbol: 'SOLUSDT', currentPrice: '150' })]))
        : json(dashboard([sym({ symbol: 'BTCUSDT', currentPrice: '64000' })])),
    );

    const rows = await screen.findAllByTestId(/^symbol-row-/);
    expect(rows).toHaveLength(2);
    // Sorted by symbol: BTCUSDT (pb) before SOLUSDT (pa).
    expect(rows[0]).toHaveAttribute('data-testid', 'symbol-row-pb-BTCUSDT');
    expect(rows[1]).toHaveAttribute('data-testid', 'symbol-row-pa-SOLUSDT');
    // The symbol name is the row's navigation link (stretched across the row),
    // routing to the per-symbol workspace page; the CONFIG action routes to that
    // symbol's config page.
    expect(screen.getByTestId('symbol-link-pb-BTCUSDT')).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/pb/symbols/BTCUSDT`,
    );
    expect(screen.getByTestId('symbol-configure-pb-BTCUSDT')).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT_ID}/profiles/pb/symbols/BTCUSDT/config`,
    );
  });

  it('sorts open positions above flat symbols, regardless of alphabetical order', async () => {
    renderTable([row('pa', 'alpha')], () =>
      json(
        dashboard([
          // Alphabetically first but flat — must NOT lead.
          sym({ symbol: 'AAVEUSDT', currentPrice: '100' }),
          // Alphabetically last but held — must lead (the operator's money).
          sym({ symbol: 'ZECUSDT', avgEntryPrice: '40', currentPrice: '45', quantity: '2' }),
        ]),
      ),
    );

    const rows = await screen.findAllByTestId(/^symbol-row-/);
    expect(rows[0]).toHaveAttribute('data-testid', 'symbol-row-pa-ZECUSDT');
    expect(rows[1]).toHaveAttribute('data-testid', 'symbol-row-pa-AAVEUSDT');
  });

  it('renders unrealised P/L for a held position and an em-dash for a flat one', async () => {
    renderTable([row('pa', 'alpha')], () =>
      json(
        dashboard([
          // (70000 - 64000) * 0.5 = 3000
          sym({
            symbol: 'BTCUSDT',
            avgEntryPrice: '64000',
            currentPrice: '70000',
            quantity: '0.5',
          }),
          sym({ symbol: 'ETHUSDT', currentPrice: '3000' }),
        ]),
      ),
    );

    const held = await screen.findByTestId('symbol-row-pa-BTCUSDT');
    expect(within(held).getByText(/\+3,?000/)).toBeInTheDocument();
    // Held P/L carries the quote-asset unit so the number is not bare; the flat
    // row omits it (its P/L is an em-dash).
    expect(within(held).getByText('USDT')).toBeInTheDocument();
    const flat = screen.getByTestId('symbol-row-pa-ETHUSDT');
    expect(within(flat).getByText(/no position/)).toBeInTheDocument();
    expect(within(flat).queryByText('USDT')).not.toBeInTheDocument();
    // Flat row has no open orders, so the order segment is hidden entirely.
    expect(within(flat).queryByText(/order/)).not.toBeInTheDocument();
  });

  it('renders singular/plural order labels and hides the segment at zero', async () => {
    renderTable([row('pa', 'alpha')], () =>
      json(
        dashboard([
          sym({ symbol: 'BTCUSDT', currentPrice: '64000', openOrderCount: 1 }),
          sym({ symbol: 'ETHUSDT', currentPrice: '3000', openOrderCount: 0 }),
          sym({ symbol: 'SOLUSDT', currentPrice: '150', openOrderCount: 3 }),
        ]),
      ),
    );

    const one = await screen.findByTestId('symbol-row-pa-BTCUSDT');
    expect(within(one).getByText(/1 order(?!s)/)).toBeInTheDocument();
    const many = screen.getByTestId('symbol-row-pa-SOLUSDT');
    expect(within(many).getByText(/3 orders/)).toBeInTheDocument();
    const none = screen.getByTestId('symbol-row-pa-ETHUSDT');
    expect(within(none).queryByText(/order/)).not.toBeInTheDocument();
  });

  it('marks a paused symbol with a hollow dot tooltip and no alarm-red', async () => {
    renderTable([row('pa', 'alpha')], () =>
      json(dashboard([sym({ symbol: 'BTCUSDT', currentPrice: '64000', enabled: false })])),
    );

    const r = await screen.findByTestId('symbol-row-pa-BTCUSDT');
    expect(within(r).getByTitle('Symbol paused — strategy not trading it')).toBeInTheDocument();
    expect(within(r).getByText('disabled')).toBeInTheDocument();
  });

  it('shows the empty state when no profile has symbols', async () => {
    renderTable([row('pa', 'alpha')], () => json(dashboard([])));
    expect(await screen.findByText('No symbols configured yet.')).toBeInTheDocument();
  });

  it('shows the error state when every profile fails to load', async () => {
    renderTable([row('pa', 'alpha')], () => new Response('boom', { status: 500 }));
    expect(await screen.findByText('Could not load symbols.')).toBeInTheDocument();
  });

  it('shows the no-match state when the filter excludes every symbol', async () => {
    renderTable([row('pa', 'alpha')], () =>
      json(dashboard([sym({ symbol: 'BTCUSDT', currentPrice: '64000' })])),
    );
    await screen.findByTestId('symbol-row-pa-BTCUSDT');
    await userEvent.type(screen.getByTestId('symbol-table-filter'), 'zzz');
    expect(await screen.findByText('No symbols match the filter.')).toBeInTheDocument();
  });

  it('filters by symbol substring', async () => {
    renderTable([row('pa', 'alpha')], () =>
      json(
        dashboard([
          sym({ symbol: 'BTCUSDT', currentPrice: '64000' }),
          sym({ symbol: 'SOLUSDT', currentPrice: '150' }),
        ]),
      ),
    );

    await screen.findByTestId('symbol-row-pa-BTCUSDT');
    await userEvent.type(screen.getByTestId('symbol-table-filter'), 'sol');
    await waitFor(() =>
      expect(screen.queryByTestId('symbol-row-pa-BTCUSDT')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('symbol-row-pa-SOLUSDT')).toBeInTheDocument();
  });

  it('derives the STATUS cell per row: HOLDING / WATCHING / PAUSED / amber blocker', async () => {
    renderTable([row('pa', 'alpha')], () =>
      json(
        dashboard([
          // Held → HOLDING regardless of enabled.
          sym({
            symbol: 'BTCUSDT',
            avgEntryPrice: '64000',
            currentPrice: '70000',
            quantity: '0.5',
          }),
          // Flat, enabled, no blocker → WATCHING.
          sym({ symbol: 'ETHUSDT', currentPrice: '3000' }),
          // Flat, enabled, blocker → amber BLOCKED, gloss in the title.
          sym({
            symbol: 'SOLUSDT',
            currentPrice: '150',
            entryBlocker: { reason: 'awaiting-trigger-price', detail: {} },
          }),
          // Disabled, flat → PAUSED.
          sym({ symbol: 'AAVEUSDT', currentPrice: '100', enabled: false }),
        ]),
      ),
    );

    const held = await screen.findByTestId('symbol-status-pa-BTCUSDT');
    expect(held).toHaveAttribute('data-status', 'holding');
    expect(held).toHaveTextContent('Holding');
    // Each kind renders the shared Badge with its semantic variant: HOLDING uses
    // the `up` green tint (same token as the success dot), so the chip carries a
    // tinted fill instead of the old border-only pill.
    expect(held.className).toMatch(/tint-up/);

    const watching = screen.getByTestId('symbol-status-pa-ETHUSDT');
    expect(watching).toHaveAttribute('data-status', 'watching');
    // WATCHING is the quiet `outline` variant — a strong border and NO fill.
    // The no-fill assertion is what distinguishes it from `secondary` (PAUSED),
    // which shares the same border but adds an elevated background.
    expect(watching.className).toMatch(/border-border-strong/);
    expect(watching.className).not.toMatch(/bg-bg-elevated/);

    const blocked = screen.getByTestId('symbol-status-pa-SOLUSDT');
    expect(blocked).toHaveAttribute('data-status', 'blocked');
    expect(blocked).toHaveTextContent('Blocked');
    // BLOCKED is the amber `warning` variant — a tinted fill (distinct from the
    // alarm-red a failure would use), matching the trade-archive status badges.
    expect(blocked.className).toMatch(/tint-warning/);
    expect(blocked.className).toMatch(/--warning/);
    // The full gloss is the hover/aria title, not the bare reason code.
    expect(blocked.getAttribute('title')).toMatch(/Waiting for the price to dip/);

    const paused = screen.getByTestId('symbol-status-pa-AAVEUSDT');
    expect(paused).toHaveAttribute('data-status', 'paused');
    // PAUSED is the neutral `secondary` variant (elevated fill, strong border).
    expect(paused.className).toMatch(/bg-bg-elevated/);
  });

  it('folds the blocker gloss onto the mobile meta line', async () => {
    renderTable([row('pa', 'alpha')], () =>
      json(
        dashboard([
          sym({
            symbol: 'SOLUSDT',
            currentPrice: '150',
            entryBlocker: { reason: 'awaiting-trigger-price', detail: {} },
          }),
        ]),
      ),
    );
    const meta = await screen.findByTestId('symbol-status-meta-pa-SOLUSDT');
    expect(meta).toHaveTextContent(/Waiting for the price to dip/);
  });

  it('flags a partial load when one profile fails but keeps the survivors', async () => {
    renderTable([row('pa', 'alpha'), row('pb', 'bravo')], (url) =>
      url.includes('/profiles/pa/dashboard')
        ? json(dashboard([sym({ symbol: 'BTCUSDT', currentPrice: '64000' })]))
        : new Response('boom', { status: 500 }),
    );

    expect(await screen.findByTestId('symbol-table-partial')).toBeInTheDocument();
    expect(screen.getByTestId('symbol-row-pa-BTCUSDT')).toBeInTheDocument();
  });

  // An OPEN position whose protective stop could not be placed is the loudest
  // status there is: it is unguarded right now. It must outrank HOLDING, which is
  // what a held position would otherwise read as.
  it('an unprotected held position reads NO STOP, not HOLDING', async () => {
    renderTable([row('pa', 'alpha')], () =>
      json(
        dashboard([
          sym({
            symbol: 'ENAUSDT',
            avgEntryPrice: '0.30',
            quantity: '189.87',
            currentPrice: '0.31',
            protectiveStopBlocker: {
              reason: 'base-locked-by-foreign-order',
              detail: { required: '189.87', free: '0' },
            },
          }),
        ]),
      ),
    );
    const status = await screen.findByTestId('symbol-status-pa-ENAUSDT');
    expect(status).toHaveAttribute('data-status', 'unprotected');
    expect(status).toHaveTextContent('No stop');
    expect(status.getAttribute('title')).toMatch(/locked by another sell order/i);
    // The gloss folds in the shortfall so the operator sees WHY it is unfundable.
    expect(status.getAttribute('title')).toContain('189.87');
  });

  // The same blocker field, a materially smaller emergency: an earlier stop is
  // still resting, the strategy just could not move it up. NO STOP here would be
  // a false alarm on a position that is in fact guarded.
  it('a stop stuck behind the exchange band reads STOP STALE, not NO STOP', async () => {
    renderTable([row('pa', 'alpha')], () =>
      json(
        dashboard([
          sym({
            symbol: 'LINKUSDT',
            avgEntryPrice: '8.416',
            quantity: '3.13',
            currentPrice: '8.832',
            protectiveStopBlocker: {
              reason: 'price-outside-exchange-band',
              detail: { price: '7.312', floor: '7.9488', avgPriceMins: 5, guarded: true },
            },
          }),
        ]),
      ),
    );
    const status = await screen.findByTestId('symbol-status-pa-LINKUSDT');
    expect(status).toHaveAttribute('data-status', 'stop-stale');
    expect(status).toHaveTextContent('Old stop');
    expect(status.getAttribute('title')).toMatch(/still resting on Binance/i);
  });
});
