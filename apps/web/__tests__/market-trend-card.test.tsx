// MarketTrendCard — the global BTC/ETH regime + breadth context band on the
// dashboard. Asserts the warming state (null snapshot), the per-symbol trend
// badges, that the verdict + breadth label track a weak vs strong market, and
// that the footer counts down to the next reading (and, once the worker has
// missed several cycles, says updates stopped and names the fix — never
// "stale", never a contradictory "updating").

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MarketTrendCard } from '@/features/dashboard/components/market-trend-card';

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const renderCard = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MarketTrendCard />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('<MarketTrendCard>', () => {
  it('renders a warming state when no snapshot exists yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ trend: null })),
    );
    renderCard();
    expect(await screen.findByTestId('market-trend-warming')).toBeInTheDocument();
  });

  it('renders a bear badge and a weak-market verdict when breadth is weak', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          trend: {
            computedAtMs: 1,
            symbols: [
              { symbol: 'BTCUSDT', price: '65719', sma50: '73492', regime: 'bear' },
              { symbol: 'ETHUSDT', price: '1795', sma50: '2048', regime: 'bear' },
            ],
            breadth: { upCount: 7, total: 15, percentUp: 46.7 },
          },
        }),
      ),
    );
    renderCard();
    expect(await screen.findByTestId('market-trend-BTCUSDT-regime')).toHaveTextContent('Bear');
    expect(screen.getByTestId('market-trend-verdict')).toHaveTextContent('Weak market');
    expect(screen.getByTestId('market-trend-breadth')).toHaveTextContent('Cautious');
  });

  it('renders a distinct error state when the read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    renderCard();
    expect(await screen.findByTestId('market-trend-error')).toHaveTextContent('unavailable');
  });

  it('renders a cautious verdict on split majors with weak breadth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          trend: {
            computedAtMs: 1,
            symbols: [
              { symbol: 'BTCUSDT', price: '80000', sma50: '73492', regime: 'bull' },
              { symbol: 'ETHUSDT', price: '1795', sma50: '2048', regime: 'bear' },
            ],
            breadth: { upCount: 6, total: 15, percentUp: 40 },
          },
        }),
      ),
    );
    renderCard();
    expect(await screen.findByTestId('market-trend-verdict')).toHaveTextContent(
      'Mixed and cautious',
    );
  });

  it('renders a strong-market verdict when both majors are rising and breadth is firm', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          trend: {
            computedAtMs: 1,
            symbols: [
              { symbol: 'BTCUSDT', price: '80000', sma50: '73492', regime: 'bull' },
              { symbol: 'ETHUSDT', price: '2500', sma50: '2048', regime: 'bull' },
            ],
            breadth: { upCount: 9, total: 15, percentUp: 60 },
          },
        }),
      ),
    );
    renderCard();
    expect(await screen.findByTestId('market-trend-verdict')).toHaveTextContent('Strong market');
  });

  const freshTrend = (computedAtMs: number) => ({
    trend: {
      computedAtMs,
      symbols: [{ symbol: 'BTCUSDT', price: '65719', sma50: '73492', regime: 'bear' }],
      breadth: { upCount: 7, total: 15, percentUp: 46.7 },
    },
  });

  it('counts down to the next reading for a fresh snapshot and does not mark it stale', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(freshTrend(Date.now()))),
    );
    renderCard();
    const age = await screen.findByTestId('market-trend-age');
    expect(age).toHaveTextContent('Next update in');
    expect(age).not.toHaveTextContent('Stale');
  });

  it('shows Checking… in the short gap once a cycle is due but the read is not yet old', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(freshTrend(Date.now() - 90_000))),
    );
    renderCard();
    const age = await screen.findByTestId('market-trend-age');
    expect(age).toHaveTextContent('Checking…');
    expect(age).not.toHaveTextContent('Restart');
  });

  it('says updates stopped and names the fix once the worker has missed several cycles', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(freshTrend(Date.now() - 10 * 60_000))),
    );
    renderCard();
    const age = await screen.findByTestId('market-trend-age');
    expect(age).toHaveTextContent('Updates stopped');
    expect(age).toHaveTextContent('Restart the worker');
    expect(age).not.toHaveTextContent('Stale');
    expect(age).not.toHaveTextContent('Updating');
  });

  // The countdown value must track how old the snapshot is, not show a constant.
  // Freeze the clock so the snapshot's computedAtMs and the component's nowMs
  // read the same instant: a 30s-old snapshot leaves exactly ~30s of the ~60s
  // cycle. (The live 1s re-render is a plain setInterval; this asserts the math.)
  it('reflects elapsed time — a 30s-old snapshot shows half the period left', async () => {
    vi.useFakeTimers();
    try {
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(freshTrend(t0 - 30_000))),
      );
      renderCard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const age = screen.getByTestId('market-trend-age');
      expect(age).toHaveTextContent('Next update in ~30s');
    } finally {
      vi.useRealTimers();
    }
  });

  // The countdown re-renders this card once a second. If that render rebuilds
  // the card's subtree instead of updating it, ~300px leaves the dashboard
  // scroller for a frame, the browser clamps `scrollTop` to the shorter
  // content, and the height coming back does not restore it — an operator
  // reading the bottom of the overview is dragged upward every second. Node
  // identity across a tick is what proves the subtree survived.
  it('keeps its DOM subtree across the once-a-second countdown re-render', async () => {
    vi.useFakeTimers();
    try {
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(freshTrend(t0 - 30_000))),
      );
      renderCard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      const cardBefore = screen.getByTestId('market-trend-card');
      const verdictBefore = screen.getByTestId('market-trend-verdict');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      // The countdown must actually have advanced, or identity holds vacuously.
      expect(screen.getByTestId('market-trend-age')).toHaveTextContent('Next update in ~29s');
      expect(screen.getByTestId('market-trend-card')).toBe(cardBefore);
      expect(screen.getByTestId('market-trend-verdict')).toBe(verdictBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flips to Checking… exactly at the cron-period boundary', async () => {
    vi.useFakeTimers();
    try {
      const t0 = 1_700_000_000_000;
      vi.setSystemTime(t0);
      // Snapshot exactly one cron period old → secsLeft 0 → past the countdown.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(freshTrend(t0 - 60_000))),
      );
      renderCard();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const age = screen.getByTestId('market-trend-age');
      expect(age).toHaveTextContent('Checking…');
      expect(age).not.toHaveTextContent('Next update');
    } finally {
      vi.useRealTimers();
    }
  });
});
