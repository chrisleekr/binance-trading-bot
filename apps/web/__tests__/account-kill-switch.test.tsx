// AccountKillSwitch — one account's emergency stop. Confirm-gated; fans the
// per-profile disable-all endpoint out to every profile still trading. Lists
// failures so a half-stopped account is never silent; collapses to an
// "All stopped" badge once nothing is trading. Lives on the account's settings
// page, which supplies the accountId it is scoped to.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountKillSwitch } from '@/features/profile/components/account-kill-switch';
import { TooltipProvider } from '@/shared/components/ui/tooltip';

import type { DashboardAggregateResponse } from '@app/contracts';

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

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

interface FetchLogEntry {
  readonly url: string;
  readonly method: string;
}

const renderKill = (
  rows: Row[],
  killResponder: (url: string) => Response = () => json({}),
): FetchLogEntry[] => {
  const log: FetchLogEntry[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      log.push({ url, method: init?.method ?? 'GET' });
      if (url.includes('/dashboard-aggregate')) return json({ profiles: rows });
      if (url.includes('/disable-all')) return killResponder(url);
      return new Response(null, { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={150}>
        <AccountKillSwitch accountId={ACCOUNT_ID} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return log;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// The account whose profiles this switch stops; the aggregate fetch is keyed by it.
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000ac';
const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('<AccountKillSwitch>', () => {
  it('confirm-gates the stop and fans disable-all out to profiles still trading', async () => {
    const log = renderKill([
      row({ profileId: PA, name: 'Real' }),
      row({ profileId: PB, name: 'Already stopped', killSwitch: true }),
    ]);

    await userEvent.click(await screen.findByTestId('global-kill'));
    const dialog = await screen.findByTestId('global-kill-dialog');
    // Only the profile still trading is listed — PB is already stopped.
    expect(within(dialog).getByText('Real')).toBeInTheDocument();
    expect(within(dialog).queryByText('Already stopped')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('global-kill-confirm'));
    await waitFor(() => expect(screen.queryByTestId('global-kill-dialog')).not.toBeInTheDocument());

    const kills = log.filter((e) => e.url.includes('/disable-all'));
    expect(kills).toEqual([
      { url: expect.stringContaining(`/profiles/${PA}/disable-all`), method: 'POST' },
    ]);
  });

  it('keeps the dialog open and names the profile when a kill call fails', async () => {
    renderKill([row({ profileId: PA, name: 'Real' })], () => new Response(null, { status: 500 }));

    await userEvent.click(await screen.findByTestId('global-kill'));
    await userEvent.click(screen.getByTestId('global-kill-confirm'));

    const errors = await screen.findByTestId('global-kill-errors');
    expect(errors).toHaveTextContent(/could not stop real/i);
    expect(screen.getByTestId('global-kill-dialog')).toBeInTheDocument();
  });

  it('on a partial fan-out failure, lists only the failed profile while still issuing every kill', async () => {
    const log = renderKill(
      [row({ profileId: PA, name: 'Real' }), row({ profileId: PB, name: 'Practice-Net' })],
      (url) => (url.includes(PB) ? new Response(null, { status: 500 }) : json({})),
    );

    await userEvent.click(await screen.findByTestId('global-kill'));
    await userEvent.click(screen.getByTestId('global-kill-confirm'));

    const errors = await screen.findByTestId('global-kill-errors');
    expect(errors).toHaveTextContent(/could not stop practice-net/i);
    expect(errors).not.toHaveTextContent(/could not stop real/i);
    expect(screen.getByTestId('global-kill-dialog')).toBeInTheDocument();
    const kills = log.filter((e) => e.url.includes('/disable-all')).map((e) => e.url);
    expect(kills).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`/profiles/${PA}/disable-all`),
        expect.stringContaining(`/profiles/${PB}/disable-all`),
      ]),
    );
    expect(kills).toHaveLength(2);
  });

  it('replaces the button with an All stopped badge when every profile is killed', async () => {
    renderKill([
      row({ profileId: PA, name: 'Real', killSwitch: true }),
      row({ profileId: PB, name: 'Practice', binanceMode: 'test', killSwitch: true }),
    ]);

    expect(await screen.findByTestId('global-kill-all-stopped')).toHaveTextContent(/all stopped/i);
    expect(screen.queryByTestId('global-kill')).not.toBeInTheDocument();
  });

  it('renders nothing before any profiles load', () => {
    renderKill([]);
    expect(screen.queryByTestId('global-kill')).not.toBeInTheDocument();
    expect(screen.queryByTestId('global-kill-all-stopped')).not.toBeInTheDocument();
  });
});
