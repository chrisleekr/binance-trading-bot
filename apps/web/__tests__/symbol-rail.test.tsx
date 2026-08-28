// SymbolRail — the compact switch rail shown beside the workspace while a symbol
// is open. Same cross-profile fan-out as the overview table (held-first), but
// its job is the in-place hop: clicking a row re-points `?sym` without a
// close/reopen. Covers the flatten/sort, the selected-row marker, the hop, and
// the filter.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SymbolRail } from '@/features/dashboard/components/symbol-rail';
import { rootRoute } from '@/app/__root';

import type { DashboardAggregateResponse, ProfileDashboardResponse } from '@app/contracts';

type Row = DashboardAggregateResponse['profiles'][number];
type Sym = ProfileDashboardResponse['symbols'][number];

// Valid-shaped uuids — `?sym` must match `^[0-9a-f-]{36}:[A-Z0-9]+$`, so the
// rail's selected marker and hop only resolve with a real uuid profile id.
const PA = '00000000-0000-4000-8000-0000000000a1';
const PB = '00000000-0000-4000-8000-0000000000b2';
// Matches the global test-setup default active account; rail rows navigate to
// the account-nested symbol route the SymbolRail links build.
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
  ...overrides,
});

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

// The rail lives on the workspace route, so the Host reads the open symbol from
// the route params — a click that navigates to another symbol's route re-renders
// the rail with the new selection, exercising the full hop.
const renderRail = (
  rows: Row[],
  responder: (url: string) => Response,
  initialEntry = `/accounts/${ACCOUNT_ID}/profiles/${PA}/symbols/BTCUSDT`,
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
  function Host() {
    const { profileId, symbol } = useParams({
      from: '/accounts/$accountId/profiles/$profileId/symbols/$symbol',
    });
    return <SymbolRail rows={rows} selected={`${profileId}:${symbol}`} />;
  }
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      stub('/'),
      stub('/onboarding'),
      stub('/login'),
      createRoute({
        getParentRoute: () => rootRoute,
        path: '/accounts/$accountId/profiles/$profileId/symbols/$symbol',
        component: Host,
      }),
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

describe('<SymbolRail>', () => {
  it('flattens symbols across profiles, held-first', async () => {
    renderRail([row(PA, 'alpha'), row(PB, 'bravo')], (url) =>
      url.includes(`/profiles/${PA}/dashboard`)
        ? // Flat, alphabetically first — must NOT lead the held one.
          json(dashboard([sym({ symbol: 'AAVEUSDT', currentPrice: '100' })]))
        : // Held — leads regardless of alphabetical order.
          json(
            dashboard([
              sym({ symbol: 'ZECUSDT', avgEntryPrice: '40', currentPrice: '45', quantity: '2' }),
            ]),
          ),
    );

    const rows = await screen.findAllByTestId(/^symbol-rail-row-/);
    expect(rows[0]).toHaveAttribute('data-testid', `symbol-rail-row-${PB}-ZECUSDT`);
    expect(rows[1]).toHaveAttribute('data-testid', `symbol-rail-row-${PA}-AAVEUSDT`);
    // The rail chip uses the same shared Badge as the table: the held row reads
    // HOLDING with the `up` green tint (not the old border-only pill).
    const heldChip = rows[0].querySelector('[data-status="holding"]');
    expect(heldChip?.textContent).toBe('Holding');
    expect(heldChip?.className).toMatch(/tint-up/);
  });

  it('does not lead with a refused seed, nor paint it as held', async () => {
    // Three things this pins at once, all of which read the SAME fact from different code. The badge comes from `deriveStatus`, which was already refusal-aware; the dot and the sort comparator were not, so before the shared predicate a refused coin sorted above a real position and wore a green holding dot beside a NOT HELD badge. A row cannot be held on one half of itself and flat on the other.
    renderRail([row(PA, 'alpha'), row(PB, 'bravo')], (url) =>
      url.includes(`/profiles/${PA}/dashboard`)
        ? json(
            dashboard([
              sym({
                symbol: 'AAVEUSDT',
                avgEntryPrice: '40',
                currentPrice: '45',
                quantity: '2',
                positionSeedRefusal: {
                  code: 'no-sellable-position',
                  since: '2026-08-27T00:00:00Z',
                },
              }),
            ]),
          )
        : json(
            dashboard([
              sym({ symbol: 'ZECUSDT', avgEntryPrice: '40', currentPrice: '45', quantity: '2' }),
            ]),
          ),
    );

    const rows = await screen.findAllByTestId(/^symbol-rail-row-/);
    // The genuinely held coin leads, even though the refused one is alphabetically first and carries an identical cost-basis row.
    expect(rows[0]).toHaveAttribute('data-testid', `symbol-rail-row-${PB}-ZECUSDT`);
    const refused = rows[1] as HTMLElement;
    expect(refused).toHaveAttribute('data-testid', `symbol-rail-row-${PA}-AAVEUSDT`);
    expect(refused.querySelector('[data-status="not-held"]')).not.toBeNull();
    expect(refused.querySelector('[data-status="holding"]')).toBeNull();
    // The dot is `aria-hidden` with no text, so it can only be asserted as an element.
    expect(refused.querySelector('span.rounded-full')?.className).not.toMatch(/bg-success/);
  });

  it('marks the row matching ?sym as current, and no other', async () => {
    renderRail(
      [row(PA, 'alpha')],
      () =>
        json(
          dashboard([
            sym({ symbol: 'BTCUSDT', currentPrice: '64000' }),
            sym({ symbol: 'SOLUSDT', currentPrice: '150' }),
          ]),
        ),
      `/accounts/${ACCOUNT_ID}/profiles/${PA}/symbols/BTCUSDT`,
    );

    const selected = await screen.findByTestId(`symbol-rail-row-${PA}-BTCUSDT`);
    expect(selected).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId(`symbol-rail-row-${PA}-SOLUSDT`)).not.toHaveAttribute('aria-current');
  });

  it('hops the selection in place when another row is clicked', async () => {
    renderRail(
      [row(PA, 'alpha')],
      () =>
        json(
          dashboard([
            sym({ symbol: 'BTCUSDT', currentPrice: '64000' }),
            sym({ symbol: 'SOLUSDT', currentPrice: '150' }),
          ]),
        ),
      `/accounts/${ACCOUNT_ID}/profiles/${PA}/symbols/BTCUSDT`,
    );

    await screen.findByTestId(`symbol-rail-row-${PA}-BTCUSDT`);
    await userEvent.click(screen.getByTestId(`symbol-rail-row-${PA}-SOLUSDT`));
    // The click re-points `?sym`; the Host re-renders the rail with the new
    // selection, so SOL becomes current and BTC is no longer.
    await waitFor(() =>
      expect(screen.getByTestId(`symbol-rail-row-${PA}-SOLUSDT`)).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
    expect(screen.getByTestId(`symbol-rail-row-${PA}-BTCUSDT`)).not.toHaveAttribute('aria-current');
  });

  it('filters by symbol substring', async () => {
    renderRail([row(PA, 'alpha')], () =>
      json(
        dashboard([
          sym({ symbol: 'BTCUSDT', currentPrice: '64000' }),
          sym({ symbol: 'SOLUSDT', currentPrice: '150' }),
        ]),
      ),
    );

    await screen.findByTestId(`symbol-rail-row-${PA}-BTCUSDT`);
    await userEvent.type(screen.getByTestId('symbol-rail-filter'), 'sol');
    await waitFor(() =>
      expect(screen.queryByTestId(`symbol-rail-row-${PA}-BTCUSDT`)).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId(`symbol-rail-row-${PA}-SOLUSDT`)).toBeInTheDocument();
  });

  it('shows the error state when every profile fails to load', async () => {
    renderRail([row(PA, 'alpha')], () => new Response('boom', { status: 500 }));
    expect(await screen.findByText('Could not load symbols.')).toBeInTheDocument();
  });

  it('flags a partial load when one profile fails but keeps the survivors', async () => {
    renderRail([row(PA, 'alpha'), row(PB, 'bravo')], (url) =>
      url.includes(`/profiles/${PA}/dashboard`)
        ? json(dashboard([sym({ symbol: 'BTCUSDT', currentPrice: '64000' })]))
        : new Response('boom', { status: 500 }),
    );
    expect(await screen.findByTestId('symbol-rail-partial')).toBeInTheDocument();
    expect(screen.getByTestId(`symbol-rail-row-${PA}-BTCUSDT`)).toBeInTheDocument();
  });

  it('shows the empty state and hides the filter when no profile has symbols', async () => {
    renderRail([row(PA, 'alpha')], () => json(dashboard([])));
    expect(await screen.findByText('No symbols configured yet.')).toBeInTheDocument();
    // The filter input is gated on having items — nothing to filter, so it hides.
    expect(screen.queryByTestId('symbol-rail-filter')).not.toBeInTheDocument();
  });

  it('shows the no-match state (not empty) when the filter excludes every symbol', async () => {
    renderRail([row(PA, 'alpha')], () =>
      json(dashboard([sym({ symbol: 'BTCUSDT', currentPrice: '64000' })])),
    );
    await screen.findByTestId(`symbol-rail-row-${PA}-BTCUSDT`);
    await userEvent.type(screen.getByTestId('symbol-rail-filter'), 'zzz');
    expect(await screen.findByText('No symbols match the filter.')).toBeInTheDocument();
  });
});
