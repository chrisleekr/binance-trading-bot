// AccountHealthBar — the always-visible "is my money OK right now" strip. Worker
// liveness (fixes the mobile blind spot), halt aggregation, today's realized
// P/L, and the approaching-limit warning. Mirrors the top-bar-status fetch-mock.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AccountHealthBar } from '@/app/account-health-bar';
import { TooltipProvider } from '@/shared/components/ui/tooltip';

import type { AccountHealthResponse } from '@app/contracts';

const PA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const base: AccountHealthResponse = {
  asOf: '2026-06-20T05:00:00.000Z',
  worker: { status: 'live', sha: 'aaaaaaa', bootedAt: '2026-06-20T00:00:00.000Z' },
  halts: [],
  todayRealized: [{ quoteAsset: 'USDT', binanceMode: 'live', realizedQuote: '12.5' }],
  approachingLimit: [],
};

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const renderBar = (health: AccountHealthResponse, tooltipDelay = 150): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/account/health')) return json(health);
      return new Response(null, { status: 404 });
    }),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider delayDuration={tooltipDelay}>
        <AccountHealthBar />
      </TooltipProvider>
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('<AccountHealthBar>', () => {
  it('shows Bot live and today realized when the worker is up', async () => {
    renderBar(base);
    expect(await screen.findByTestId('account-health-worker')).toHaveTextContent(/bot live/i);
    expect(screen.getByTestId('account-health-today')).toHaveTextContent(/USDT/);
  });

  it('shows Bot down — restart worker when the heartbeat is missing', async () => {
    renderBar({ ...base, worker: { status: 'down', sha: null, bootedAt: null } });
    expect(await screen.findByTestId('account-health-worker')).toHaveTextContent(/bot down/i);
  });

  it('aggregates active halts into a count badge', async () => {
    renderBar({
      ...base,
      halts: [
        { profileId: PA, name: 'Real', kind: 'daily-loss' },
        { profileId: PB, name: 'Momentum', kind: 'daily-loss' },
      ],
    });
    expect(await screen.findByTestId('account-health-halts')).toHaveTextContent(/2 paused/i);
  });

  it('warns when a profile is approaching its daily-loss limit', async () => {
    renderBar({
      ...base,
      approachingLimit: [{ profileId: PA, name: 'Real', lossQuote: '-42', limitQuote: '50' }],
    });
    expect(await screen.findByTestId('account-health-approaching')).toHaveTextContent(
      /near limit/i,
    );
  });

  it('narrows the loss and limit inside the tooltip, which is where the numbers actually live', async () => {
    // The chip only carries a count. The wire values are full-scale decimal strings and they are painted in the TooltipContent, which never renders until the trigger is opened, so an assertion on the trigger alone leaves the formatter unpinned: delete it and the suite still passes.
    renderBar(
      {
        ...base,
        approachingLimit: [
          {
            profileId: PA,
            name: 'Real',
            lossQuote: '-42.190283746152',
            limitQuote: '50.000000000001',
          },
        ],
      },
      0,
    );
    const user = userEvent.setup();
    await user.hover(await screen.findByTestId('account-health-approaching'));

    // Radix mirrors the content into a visually-hidden copy for screen readers, so both matches are the same painted text.
    const painted = await screen.findAllByText(/^Real: /);
    expect(painted.length).toBeGreaterThan(0);
    for (const node of painted) {
      expect(node.textContent).toContain('-42.19');
      expect(node.textContent).toContain('50.00');
      expect(node.textContent).not.toContain('-42.190283746152');
      expect(node.textContent).not.toContain('50.000000000001');
    }
  });

  it('excludes practice (test-mode) P/L from the headline', async () => {
    renderBar({
      ...base,
      todayRealized: [{ quoteAsset: 'USDT', binanceMode: 'test', realizedQuote: '999' }],
    });
    await screen.findByTestId('account-health-worker');
    expect(screen.queryByTestId('account-health-today')).toBeNull();
  });
});
