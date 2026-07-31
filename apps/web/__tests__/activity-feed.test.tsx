import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ActivityFeed } from '@/features/dashboard/components/activity-feed';

import { DiscoveryConfigSchema } from '@app/contracts';
import type {
  AuditLogListResponse,
  DashboardAggregateResponse,
  DiscoveryActivityEntry,
  DiscoveryDashboardResponse,
} from '@app/contracts';

// The feed fans out one audit-log fetch per profile. Drive each profile's
// outcome by stubbing global fetch (the repo pattern): a 5xx Response makes
// apiFetch throw an ApiError that React Query catches as query error state —
// unlike a bare Promise.reject, which floats as an unhandled rejection.
type Row = DashboardAggregateResponse['profiles'][number];

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

const page = (
  items: readonly { id: string; event: string; createdAt: string }[],
): AuditLogListResponse => ({
  items: items.map((i) => ({ ...i, actor: 'operator', payload: null, ip: null, userAgent: null })),
  nextCursor: null,
});

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

// A fully-shaped discovery dashboard payload carrying only the activity rows
// the test cares about; the schema fills every other required field from its
// defaults so apiFetch's zod parse succeeds.
const discoveryJson = (activity: readonly DiscoveryActivityEntry[]): Response => {
  const body: DiscoveryDashboardResponse = {
    config: DiscoveryConfigSchema.parse({}),
    quoteAsset: 'USDT',
    scoreboard: {
      realizedProfit: '0',
      realizedProfitPercent: '0',
      tradeCount: 0,
      winRate: 0,
      realizedProfit7d: '0',
      tradeCount7d: 0,
    },
    gauge: { deployedQuote: '0', maxAccountExposureQuote: null, autoSymbolCount: 0 },
    universe: null,
    holdings: [],
    autoSymbols: [],
    activity: [...activity],
  };
  return json(body);
};

// Profile ids only need to be distinct strings for URL matching; entry ids go
// through apiFetch's zod parse, so they must be RFC-valid UUIDs.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const EA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// `responder` answers audit-log fetches. Discovery fetches are routed to
// `discovery` when supplied, else default to an empty-activity payload; the
// per-profile action-logs (errors) fetch is routed to `actionErrors` when
// supplied, else an empty list — so the audit-only tests don't have to know the
// feed now fans out further sources.
const renderFeed = (
  rows: Row[],
  responder: (url: string) => Response,
  discovery?: (url: string) => Response,
  actionErrors?: (url: string) => Response,
): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/discovery')) return discovery ? discovery(url) : discoveryJson([]);
      if (url.includes('/action-logs'))
        return actionErrors ? actionErrors(url) : json({ items: [] });
      return responder(url);
    }),
  );
  // retry:false so a 5xx settles to error state on the first attempt.
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ActivityFeed rows={rows} />
    </QueryClientProvider>,
  );
};

afterEach(() => vi.unstubAllGlobals());

describe('<ActivityFeed>', () => {
  it('merges every profile’s events into one list, newest first, humanizing the event token', async () => {
    renderFeed([row(A, 'alpha'), row(B, 'bravo')], (url) =>
      url.includes(A)
        ? json(page([{ id: EA, event: 'order.placed', createdAt: '2026-06-01T10:00:00.000Z' }]))
        : json(page([{ id: EB, event: 'symbol.added', createdAt: '2026-06-02T10:00:00.000Z' }])),
    );

    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(2);
    // bravo's symbol.added (Jun 2) is newer than alpha's order.placed (Jun 1).
    expect(items[0]).toHaveTextContent('Symbol added');
    expect(items[0]).toHaveTextContent('bravo');
    expect(items[1]).toHaveTextContent('Order placed');
    expect(items[1]).toHaveTextContent('alpha');
  });

  it('flags a partial load when one profile fails but another succeeds', async () => {
    renderFeed([row(A, 'alpha'), row(B, 'bravo')], (url) =>
      url.includes(A)
        ? json(page([{ id: EA, event: 'order.placed', createdAt: '2026-06-01T10:00:00.000Z' }]))
        : new Response('boom', { status: 500 }),
    );

    const partial = await screen.findByTestId('activity-partial');
    expect(partial).toBeInTheDocument();
    // The banner names which profile failed so the operator knows what is stale.
    expect(partial).toHaveTextContent('bravo');
    // The surviving profile's event is still shown — the failure does not blank the feed.
    expect(screen.getByText('Order placed')).toBeInTheDocument();
  });

  it('shows the error state when every profile fails to load', async () => {
    renderFeed([row(A, 'alpha')], () => new Response('boom', { status: 500 }));

    expect(await screen.findByText('Could not load recent activity.')).toBeInTheDocument();
  });

  it('filters the feed to a category chip and keeps it under "all"', async () => {
    renderFeed([row(A, 'alpha')], () =>
      json(
        page([
          { id: EA, event: 'add-symbol', createdAt: '2026-06-02T10:00:00.000Z' },
          { id: EB, event: 'manual-order', createdAt: '2026-06-01T10:00:00.000Z' },
        ]),
      ),
    );

    // Default chip is "all": both the discovery and the trade event show.
    expect(await screen.findByText('Add symbol')).toBeInTheDocument();
    expect(screen.getByText('Manual order')).toBeInTheDocument();

    // Discovery chip: add-symbol stays, manual-order (a trade) drops out.
    await userEvent.click(screen.getByTestId('activity-filter-discovery'));
    expect(screen.getByText('Add symbol')).toBeInTheDocument();
    expect(screen.queryByText('Manual order')).toBeNull();

    // Trades chip: the discovery event is hidden, manual-order returns.
    await userEvent.click(screen.getByTestId('activity-filter-trades'));
    expect(screen.queryByText('Add symbol')).toBeNull();
    expect(screen.getByText('Manual order')).toBeInTheDocument();
  });

  it('merges a discovery cron ADD/REMOVE under the discovery chip and all, not trades', async () => {
    renderFeed(
      [row(A, 'alpha')],
      () => json(page([{ id: EA, event: 'manual-order', createdAt: '2026-06-01T10:00:00.000Z' }])),
      () =>
        discoveryJson([
          { time: '2026-06-02T10:00:00.000Z', symbol: 'PEPEUSDT', action: 'add', msg: 'trending' },
        ]),
    );

    // 'all' shows both the audit trade and the discovery cron row.
    expect(await screen.findByText(/Discovery added/)).toBeInTheDocument();
    expect(screen.getByText('PEPEUSDT')).toBeInTheDocument();
    expect(screen.getByText('Manual order')).toBeInTheDocument();

    // Discovery chip: the cron ADD stays (matching the profile page), the trade drops.
    await userEvent.click(screen.getByTestId('activity-filter-discovery'));
    expect(screen.getByText('PEPEUSDT')).toBeInTheDocument();
    expect(screen.queryByText('Manual order')).toBeNull();

    // Trades chip: the discovery cron row is NOT a trade, so it disappears.
    await userEvent.click(screen.getByTestId('activity-filter-trades'));
    expect(screen.queryByText('PEPEUSDT')).toBeNull();
    expect(screen.getByText('Manual order')).toBeInTheDocument();
  });

  it('merges an action-log error row under the errors chip and all, not trades/discovery', async () => {
    renderFeed(
      [row(A, 'alpha')],
      () => json(page([{ id: EA, event: 'manual-order', createdAt: '2026-06-01T10:00:00.000Z' }])),
      () =>
        discoveryJson([
          { time: '2026-06-03T10:00:00.000Z', symbol: 'PEPEUSDT', action: 'add', msg: 'trending' },
        ]),
      () =>
        json({
          items: [
            {
              time: '2026-06-04T10:00:00.000Z',
              symbol: 'WLDUSDT',
              level: 'error',
              msg: 'order rejected: insufficient balance',
            },
            // A null-symbol error row: a worker-wide failure with no symbol.
            // Renders without a stray "null" and without a key collision.
            {
              time: '2026-06-05T10:00:00.000Z',
              symbol: null,
              level: 'warn',
              msg: 'degraded read',
            },
          ],
        }),
    );

    // 'all' shows the audit trade, the discovery cron row, and the error rows.
    expect(await screen.findByText('order rejected: insufficient balance')).toBeInTheDocument();
    // The null-symbol row renders its message with no stray "null".
    expect(screen.getByText('degraded read')).toBeInTheDocument();
    expect(screen.getByText('Manual order')).toBeInTheDocument();
    expect(screen.getByText('PEPEUSDT')).toBeInTheDocument();

    // Errors chip: only the error row stays; trade and discovery rows drop.
    await userEvent.click(screen.getByTestId('activity-filter-errors'));
    expect(screen.getByText('order rejected: insufficient balance')).toBeInTheDocument();
    expect(screen.queryByText('Manual order')).toBeNull();
    expect(screen.queryByText('PEPEUSDT')).toBeNull();

    // Trades chip: the error row is not a trade, so it disappears.
    await userEvent.click(screen.getByTestId('activity-filter-trades'));
    expect(screen.queryByText('order rejected: insufficient balance')).toBeNull();
    expect(screen.getByText('Manual order')).toBeInTheDocument();

    // Discovery chip: the error row is not a discovery row either.
    await userEvent.click(screen.getByTestId('activity-filter-discovery'));
    expect(screen.queryByText('order rejected: insufficient balance')).toBeNull();
    expect(screen.getByText('PEPEUSDT')).toBeInTheDocument();
  });

  it('an error row surfaces the failure reason from ctx.results', async () => {
    // "1 order action(s) failed" alone sends the operator to the logs. The reason
    // the executor already recorded is the answer, and it rides in the structured
    // `ctx.results` — read it there, not by re-parsing the sentence.
    renderFeed(
      [row(A, 'alpha')],
      () => json(page([])),
      undefined,
      () =>
        json({
          items: [
            {
              time: '2026-06-04T10:00:00.000Z',
              symbol: 'ALLOUSDT',
              level: 'warn',
              msg: 'ALLOUSDT: 1 order action(s) failed, none succeeded',
              ctx: {
                results: [
                  { type: 'cancel-order', ok: true },
                  {
                    type: 'place-order',
                    ok: false,
                    reason: 'binance logic -2010: insufficient balance',
                  },
                ],
              },
            },
            // No ctx at all: the row must still render, with no reason line.
            {
              time: '2026-06-05T10:00:00.000Z',
              symbol: 'BTCUSDT',
              level: 'error',
              msg: 'degraded read',
            },
          ],
        }),
    );

    expect(
      await screen.findByText('binance logic -2010: insufficient balance'),
    ).toBeInTheDocument();
    expect(screen.getByText('degraded read')).toBeInTheDocument();
  });

  it('keeps the errors source best-effort: a failed action-logs fetch does not raise the partial banner', async () => {
    renderFeed(
      [row(A, 'alpha')],
      () => json(page([{ id: EA, event: 'manual-order', createdAt: '2026-06-01T10:00:00.000Z' }])),
      undefined,
      // The errors source fails, but it is best-effort: the feed must not flag a
      // partial load (the audit source owns that signal). Mirror the audit
      // partial-load test's 5xx mechanism.
      () => new Response('boom', { status: 500 }),
    );

    // The succeeding audit row still renders.
    expect(await screen.findByText('Manual order')).toBeInTheDocument();
    // The errors failure must NOT surface the partial banner.
    expect(screen.queryByTestId('activity-partial')).toBeNull();
  });

  it('applies the category filter before the feed limit, so an older match still shows', async () => {
    // 13 newest events are all trades (manual-order); one older discovery event
    // sits below the FEED_LIMIT (12) cutoff. Filtering before slicing must keep
    // it visible under the discovery chip.
    const trades = Array.from({ length: 13 }, (_, i) => ({
      id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      event: 'manual-order',
      // Newest first when sorted desc: June 20 down to June 8.
      createdAt: `2026-06-${String(20 - i).padStart(2, '0')}T10:00:00.000Z`,
    }));
    renderFeed(
      [row(A, 'alpha')],
      () => json(page(trades)),
      () =>
        discoveryJson([
          // Older than all 13 trades, so it would be sliced away if the limit
          // were applied before the filter.
          { time: '2026-06-01T10:00:00.000Z', symbol: 'WLDUSDT', action: 'remove', msg: 'faded' },
        ]),
    );

    await userEvent.click(await screen.findByTestId('activity-filter-discovery'));
    expect(await screen.findByText('WLDUSDT')).toBeInTheDocument();
    expect(screen.getByText(/Discovery removed/)).toBeInTheDocument();
    // No trade rows under the discovery chip.
    expect(screen.queryByText('Manual order')).toBeNull();
  });
});
