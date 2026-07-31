// RealisedPnlCard — the D/W/M/ALL period selector reads the period-specific
// closed-trades query and colours the total by sign. Extracted from the
// retired ProfileLossSummary; the unrealised half now lives on the dashboard
// SummaryBand and is covered by aggregate-pnl / unrealised-pnl tests.

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClosedTradesPeriod } from '@app/contracts';
import { RealisedPnlCard } from '../src/features/profile/components/realised-pnl-card.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';

// The card is controlled (#504): the parent owns the period. This harness
// supplies that state so the toggle behaves as it does inside ScopedKpiStrip.
function Harness(): React.JSX.Element {
  const [period, setPeriod] = useState<ClosedTradesPeriod>('d');
  return <RealisedPnlCard profileId={PROFILE_ID} period={period} onPeriodChange={setPeriod} />;
}

/** Closed-trades responder — echoes the requested period and serves a fixed total. */
const closedTradesResponse = (url: string): Response => {
  const period = new URL(url, 'http://t').searchParams.get('period') ?? 'd';
  return new Response(
    JSON.stringify({
      period,
      tz: 'UTC',
      from: '2026-05-17T00:00:00.000Z',
      to: '2026-05-18T00:00:00.000Z',
      totalProfit: '125.50',
      totalProfitPercent: '4.20',
      tradeCount: 3,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

const renderCard = (): ReturnType<typeof vi.fn> => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => closedTradesResponse(String(input)));
  vi.stubGlobal('fetch', fetchMock);
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Harness />
    </QueryClientProvider>,
  );
  return fetchMock;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RealisedPnlCard', () => {
  it('queries the default day period and refetches when a period button is clicked', async () => {
    const user = userEvent.setup();
    const fetchMock = renderCard();

    await waitFor(() => expect(screen.getByTestId('realised-trade-count')).toBeInTheDocument());
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('period=d');
    // tz is required by the contract and resolves the period boundaries.
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('tz=');

    await user.click(screen.getByTestId('realised-period-w'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('period=w'))).toBe(true),
    );
  });

  it('re-reads the period-specific query for the M and All toggles', async () => {
    const user = userEvent.setup();
    // Serve a distinct total per period so a stale read (wrong cache slot)
    // would show the wrong number. The card re-reads ['closed-trades', id,
    // period, tz]; clicking M/All must surface the M/All totals.
    const totals: Record<string, string> = { d: '1.00', w: '2.00', m: '33.00', a: '444.00' };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const period = new URL(String(input), 'http://t').searchParams.get('period') ?? 'd';
      return new Response(
        JSON.stringify({
          period,
          tz: 'UTC',
          from: '2026-05-17T00:00:00.000Z',
          to: '2026-05-18T00:00:00.000Z',
          totalProfit: totals[period] ?? '0',
          totalProfitPercent: '1.00',
          tradeCount: 3,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('realised-total-profit')).toHaveTextContent('+1'),
    );

    await user.click(screen.getByTestId('realised-period-m'));
    await waitFor(() =>
      expect(screen.getByTestId('realised-total-profit')).toHaveTextContent('+33'),
    );

    await user.click(screen.getByTestId('realised-period-a'));
    await waitFor(() =>
      expect(screen.getByTestId('realised-total-profit')).toHaveTextContent('+444'),
    );
  });

  it('colours the realised total by the sign of the profit', async () => {
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId('realised-total-profit')).toHaveTextContent('+125.5'),
    );
    expect(screen.getByTestId('realised-total-profit')).toHaveClass('text-success');
    expect(screen.getByTestId('realised-percent')).toHaveTextContent('+4.20%');
  });

  it('renders an em-dash realised total and hides the percent badge when no trades closed in the period', async () => {
    // 0 closed trades has no denominator — a "0 / 0.00%" readout reads as
    // "broke even on N trades" rather than "no activity".
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            period: 'd',
            tz: 'UTC',
            from: '2026-05-23T00:00:00.000Z',
            to: '2026-05-24T00:00:00.000Z',
            totalProfit: '0',
            totalProfitPercent: '0',
            tradeCount: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Harness />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('realised-total-profit')).toHaveTextContent('—'));
    expect(screen.queryByTestId('realised-percent')).not.toBeInTheDocument();
  });
});
