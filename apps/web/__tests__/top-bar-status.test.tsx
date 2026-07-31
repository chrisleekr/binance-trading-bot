// TopBarStatus — the header's status cluster: the worker-health LED. Unrealised
// P/L moved into the trading ticker (top-bar-ticker.test.tsx), so it is no longer
// asserted here. The global stop lives in its own component (global-kill-switch).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TopBarStatus } from '@/app/top-bar-status';
import { TooltipProvider } from '@/shared/components/ui/tooltip';

import type { DashboardAggregateResponse, StatusResponse } from '@app/contracts';

type Row = DashboardAggregateResponse['profiles'][number];

const row = (overrides: Partial<Row> & { profileId: string; name: string }): Row => ({
  enabled: true,
  binanceMode: 'live',
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

const okStatus: StatusResponse = {
  api: { sha: 'aaaaaaa', bootedAt: '2026-06-13T00:00:00.000Z' },
  worker: { sha: 'aaaaaaa', bootedAt: '2026-06-13T00:00:00.000Z' },
  study: { sha: 'aaaaaaa', bootedAt: '2026-06-13T00:00:00.000Z' },
  db: { latestMigrationAppliedAt: null },
  fleet: { total: 1, ready: 1 },
};

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const renderCluster = (rows: Row[], status: StatusResponse | null = okStatus): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/dashboard-aggregate')) return json({ profiles: rows });
      if (url.includes('/status')) {
        return status ? json(status) : new Response(null, { status: 500 });
      }
      return new Response(null, { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      {/* The real app provides this at __root; Radix tooltips need it. */}
      <TooltipProvider delayDuration={150}>
        <TopBarStatus />
      </TooltipProvider>
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// Valid uuid: DashboardAggregateRow parses profileId via z.uuid().
const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('<TopBarStatus>', () => {
  it('shows Bot live when the worker is up and aligned', async () => {
    renderCluster([row({ profileId: PA, name: 'Real' })]);
    expect(await screen.findByTestId('topbar-health')).toHaveTextContent(/bot live/i);
  });

  it('shows Bot down when the worker heartbeat is missing', async () => {
    renderCluster([row({ profileId: PA, name: 'Real' })], { ...okStatus, worker: null });
    expect(await screen.findByTestId('topbar-health')).toHaveTextContent(/bot down/i);
  });

  it('shows Restart needed on api/worker build skew', async () => {
    renderCluster([row({ profileId: PA, name: 'Real' })], {
      ...okStatus,
      worker: { sha: 'bbbbbbb', bootedAt: '2026-06-13T00:00:00.000Z' },
    });
    expect(await screen.findByTestId('topbar-health')).toHaveTextContent(/restart needed/i);
  });
});
