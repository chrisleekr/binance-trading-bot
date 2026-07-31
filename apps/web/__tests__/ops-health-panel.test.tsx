// OpsHealthPanel — per-cron last-run status on the Account page.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OpsHealthPanel } from '@/features/account/components/ops-health-panel';

import type { WorkerCronsResponse } from '@app/contracts';

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const setUp = (body: WorkerCronsResponse): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/worker/crons')) return json(body);
      return new Response(null, { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <OpsHealthPanel />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const now = Date.now();

describe('<OpsHealthPanel>', () => {
  it('lists each cron with its name', async () => {
    setUp({
      asOf: new Date(now).toISOString(),
      crons: [
        {
          name: 'discovery-run',
          lastRunAtMs: now - 30_000,
          status: 'ok',
          durationMs: 5,
          error: null,
        },
        {
          name: 'market-trend',
          lastRunAtMs: now - 90_000,
          status: 'ok',
          durationMs: 8,
          error: null,
        },
      ],
    });
    expect(await screen.findByTestId('cron-discovery-run')).toBeInTheDocument();
    expect(screen.getByTestId('cron-market-trend')).toBeInTheDocument();
  });

  it('flags failing crons with a count and shows the error', async () => {
    setUp({
      asOf: new Date(now).toISOString(),
      crons: [
        {
          name: 'db-backup',
          lastRunAtMs: now - 10_000,
          status: 'error',
          durationMs: 12,
          error: 'pg_dump exited 1',
        },
      ],
    });
    // Wait on the data-dependent error text (the panel renders "Loading…" first),
    // scoped to the failing cron's row so the error is asserted in place.
    const row = await screen.findByTestId('cron-db-backup');
    expect(within(row).getByText(/pg_dump exited 1/)).toBeInTheDocument();
    expect(screen.getByTestId('ops-health-panel')).toHaveTextContent(/1 failing/i);
  });

  it('shows a worker-may-be-down hint when nothing has reported', async () => {
    setUp({ asOf: new Date(now).toISOString(), crons: [] });
    expect(await screen.findByText(/worker may be down/i)).toBeInTheDocument();
  });

  it('shows an error alert when the status fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <OpsHealthPanel />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/could not load job status/i)).toBeInTheDocument();
  });
});
