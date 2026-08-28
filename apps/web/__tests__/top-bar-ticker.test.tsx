// TopBarTicker — header live-trading-summary strip: open positions, realised
// P/L today per quote, open orders, over live+enabled profiles only. Mirrors the
// top-bar-status test setup: a stubbed fetch feeds /dashboard-aggregate and the
// per-profile /closed-trades polls the marquee fans out.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopBarTicker, TopBarTickerBar } from '@/app/top-bar-ticker';

import type {
  ClosedTradesResponse,
  DashboardAggregateResponse,
  ProfileDashboardResponse,
  ProfileDashboardSymbol,
} from '@app/contracts';

type Row = DashboardAggregateResponse['profiles'][number];

const row = (overrides: Partial<Row> & { profileId: string; name: string }): Row => ({
  enabled: true,
  binanceMode: 'live',
  quoteAsset: 'USDT',
  lastTickAt: null,
  lastTickLatencyMs: null,
  apiKeyConfigured: true,
  lastTickError: null,
  killSwitch: false,
  openOrderCount: 0,
  openPositionCount: 0,
  positions: [],
  ...overrides,
});

const closedTrades = (totalProfit: string): ClosedTradesResponse => ({
  period: 'd',
  tz: 'UTC',
  from: '2026-06-16T00:00:00.000Z',
  to: '2026-06-16T23:59:59.999Z',
  totalProfit,
  totalProfitPercent: '0',
  tradeCount: 1,
});

const sym = (
  overrides: Partial<ProfileDashboardSymbol> & { symbol: string },
): ProfileDashboardSymbol => ({
  enabled: true,
  source: 'manual',
  avgEntryPrice: null,
  currentPrice: null,
  quantity: null,
  openOrderCount: 0,
  openOrders: [],
  entryBlocker: null,
  ...overrides,
});

const profileDashboard = (
  profileId: string,
  symbols: ProfileDashboardSymbol[],
): ProfileDashboardResponse => ({
  profileId,
  enabled: true,
  binanceMode: 'live',
  quoteAsset: 'USDT',
  balances: [],
  totalProfit: '0',
  enabledNotifierCount: 0,
  symbols,
  cachedAt: '2026-06-16T00:00:00.000Z',
});

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

// Valid uuids: DashboardAggregateRow parses profileId via z.uuid().
const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const renderTicker = (
  rows: Row[],
  closedByProfile: Record<string, string> = {},
  Component: () => React.JSX.Element = TopBarTicker,
  symbolsByProfile: Record<string, ProfileDashboardSymbol[]> = {},
): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/dashboard-aggregate')) return json({ profiles: rows });
      // Check /closed-trades before /dashboard so neither pattern shadows the other.
      const closedMatch = url.match(/\/profiles\/([^/]+)\/closed-trades/);
      if (closedMatch) {
        const profit = closedByProfile[closedMatch[1]] ?? '0';
        return json(closedTrades(profit));
      }
      const dashMatch = url.match(/\/profiles\/([^/]+)\/dashboard$/);
      if (dashMatch) {
        return json(profileDashboard(dashMatch[1], symbolsByProfile[dashMatch[1]] ?? []));
      }
      return new Response(null, { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <Component />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<TopBarTicker>', () => {
  it('renders the desktop summary metrics in order: positions, orders, unrealised, today', async () => {
    renderTicker([row({ profileId: PA, name: 'Real', openPositionCount: 2, openOrderCount: 3 })], {
      [PA]: '12.5',
    });

    const strip = await screen.findByTestId('topbar-ticker');
    expect(strip.className).toContain('hidden');
    expect(strip.className).toContain('md:flex');

    // Realised P/L appears once the closed-trades poll resolves. The marquee
    // repeats its run for the seamless loop, so the testid appears many times.
    expect(
      (await within(strip).findAllByTestId('topbar-ticker-realised-USDT')).length,
    ).toBeGreaterThanOrEqual(1);

    // Visible order in one run: Positions, Open orders, Unrealised P/L, Today.
    // The marquee repeats its run, so compare first occurrences.
    const text = strip.textContent ?? '';
    const posIdx = text.indexOf('Positions');
    const ordersIdx = text.indexOf('Open orders');
    const unrealisedIdx = text.indexOf('Unrealised P/L');
    const todayIdx = text.indexOf('Today');
    expect(posIdx).toBeGreaterThanOrEqual(0);
    expect(posIdx).toBeLessThan(ordersIdx);
    expect(ordersIdx).toBeLessThan(unrealisedIdx);
    expect(unrealisedIdx).toBeLessThan(todayIdx);
    expect(text).toContain('USDT');
  });

  it('renders a chip per held coin with its base symbol and P/L', async () => {
    renderTicker(
      [row({ profileId: PA, name: 'Real', quoteAsset: 'USDT', openPositionCount: 1 })],
      { [PA]: '0' },
      TopBarTicker,
      {
        [PA]: [
          sym({ symbol: 'BTCUSDT', avgEntryPrice: '100', currentPrice: '110', quantity: '2' }),
        ],
      },
    );
    const strip = await screen.findByTestId('topbar-ticker');
    const coins = await within(strip).findAllByTestId('topbar-ticker-coin-BTCUSDT');
    expect(coins.length).toBeGreaterThanOrEqual(1);
    // The chip carries the base symbol and the +10.00% move. Two decimals because the chip now shares the one PnlPercent readout with every other P/L percent in the app; a ratio rendered at a different precision here than in the panel below it reads as two different numbers.
    expect(coins[0]?.textContent).toContain('BTC');
    expect(coins[0]?.textContent).toContain('+10.00%');
  });

  it('groups realised P/L per quote across two live profiles with different quote assets', async () => {
    renderTicker(
      [
        row({ profileId: PA, name: 'RealUsdt', quoteAsset: 'USDT', openPositionCount: 1 }),
        row({ profileId: PB, name: 'RealBtc', quoteAsset: 'BTC', openPositionCount: 1 }),
      ],
      { [PA]: '12.5', [PB]: '0.002' },
    );

    const strip = await screen.findByTestId('topbar-ticker');
    // The useQueries fan-out re-joins each closed-trades result to its row by
    // array index to recover quoteAsset, then groups per quote. Both quotes must
    // render their own realised slot.
    expect(
      (await within(strip).findAllByTestId('topbar-ticker-realised-USDT')).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await within(strip).findAllByTestId('topbar-ticker-realised-BTC')).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('carries the animate-ticker class on the marquee wrapper', async () => {
    renderTicker([row({ profileId: PA, name: 'Real', openPositionCount: 1 })]);
    const strip = await screen.findByTestId('topbar-ticker');
    // The animation is wired via this class; assert it is present.
    expect(strip.querySelector('.animate-ticker')).not.toBeNull();
  });

  it('renders the mobile sub-bar with the ticker content, hidden on desktop', async () => {
    renderTicker([row({ profileId: PA, name: 'Real', openPositionCount: 1 })], {}, TopBarTickerBar);
    const bar = await screen.findByTestId('topbar-ticker-mobile');
    expect(bar).toHaveClass('md:hidden');
    // It carries the same scrolling marquee, not a lone icon.
    expect(bar.querySelector('.animate-ticker')).not.toBeNull();
    expect(bar.textContent ?? '').toContain('Positions');
  });

  it('renders a zero-state with no live positions, orders, or closed trades', async () => {
    renderTicker([row({ profileId: PA, name: 'Real' })]);
    const strip = await screen.findByTestId('topbar-ticker');
    const text = strip.textContent ?? '';
    expect(text).toContain('Positions');
    expect(text).toContain('Open orders');
    // No crash; counts render as 0.
    expect(text).toContain('0');
  });

  it('never sums practice or paused profiles into the headline', async () => {
    const PC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    renderTicker(
      [
        row({ profileId: PA, name: 'Practice', binanceMode: 'test', openPositionCount: 9 }),
        row({ profileId: PB, name: 'Paused', enabled: false, openOrderCount: 7 }),
        row({ profileId: PC, name: 'Live', openPositionCount: 4, openOrderCount: 2 }),
      ],
      { [PA]: '99999', [PB]: '88888', [PC]: '0' },
    );
    const strip = await screen.findByTestId('topbar-ticker');
    // Prove exclusion by exact-equality on the surviving total: only the live
    // profile's counts reach the headline, so positions=4 and orders=2, not the
    // excluded 9/7. The marquee repeats its run for the loop, so each value span
    // renders many times; assert at least one and that the excluded digits never
    // appear.
    expect((await within(strip).findAllByText('4')).length).toBeGreaterThanOrEqual(1);
    expect((await within(strip).findAllByText('2')).length).toBeGreaterThanOrEqual(1);
    const text = strip.textContent ?? '';
    expect(text).not.toContain('9');
    expect(text).not.toContain('7');
  });
});
