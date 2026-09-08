import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EquityPnlCard } from '@/features/dashboard/components/equity-pnl-card';
import { createQueryClient } from '@/shared/lib/query-client';

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';

const snapshotsResponse = (
  benchmarkMode: 'btc' | 'basket',
  feeBasis: 'exact' | 'estimated' | 'unknown' = 'exact',
): Response =>
  new Response(
    JSON.stringify({
      profileId: PROFILE_ID,
      quoteAsset: 'USDT',
      benchmarkMode,
      points: [
        {
          capturedAt: '2026-06-19T00:00:00.000Z',
          netPnlQuote: '0',
          realizedNetQuote: '0',
          positionValueQuote: '0',
          positionCostQuote: '100',
          benchmarkAsset: 'BTC',
          benchmarkPriceQuote: '100',
          feeBasis,
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const profileResponse = (benchmarkMode: 'btc' | 'basket'): Response =>
  new Response(
    JSON.stringify({
      id: PROFILE_ID,
      accountId: PROFILE_ID,
      name: 'P',
      strategyName: 'trailing-trade',
      strategyVersion: '1.0.0',
      config: {},
      enabled: false,
      binanceMode: 'test',
      quoteAsset: 'USDT',
      benchmarkMode,
      createdAt: '2026-06-19T00:00:00.000Z',
      updatedAt: '2026-06-19T00:00:00.000Z',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('EquityPnlCard benchmark selector', () => {
  afterEach(() => vi.unstubAllGlobals());

  const renderCard = (
    mode: 'btc' | 'basket',
    feeBasis: 'exact' | 'estimated' | 'unknown' = 'exact',
  ): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return profileResponse('basket');
      return snapshotsResponse(mode, feeBasis);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <EquityPnlCard profileId={PROFILE_ID} />
      </QueryClientProvider>,
    );
    return fetchMock;
  };

  it('reflects the profile benchmark mode in the selector and heading', async () => {
    renderCard('basket');
    const select = await screen.findByTestId<HTMLSelectElement>('equity-benchmark-mode');
    // The selector renders during loading with the 'btc' default; wait for the
    // query to resolve and flip it to the profile's stored mode.
    await waitFor(() => expect(select.value).toBe('basket'));
    expect(screen.getByText('Profit vs holding your basket')).toBeInTheDocument();
  });

  it('marks the headline when the plotted window rests on an unaccounted charge', async () => {
    // The point is no longer withheld server-side, so this marker is the ONLY thing standing between a curve built on a total known to be short and a reader taking it as a certified Net P/L. It reuses the archive rollup's wording so the two surfaces mean the same thing by the same phrase.
    renderCard('btc', 'unknown');
    expect(await screen.findByTestId('equity-fee-basis')).toHaveTextContent('fees not accounted');
  });

  it('leaves the headline unmarked when every plotted point is exact', async () => {
    // Without this the marker could be unconditional, which trains the operator to ignore it.
    renderCard('btc');
    await screen.findByTestId<HTMLSelectElement>('equity-benchmark-mode');
    await waitFor(() => expect(screen.getByText(/Net P\/L/)).toBeInTheDocument());
    expect(screen.queryByTestId('equity-fee-basis')).toBeNull();
  });

  it('PATCHes the profile when the operator changes the benchmark', async () => {
    const fetchMock = renderCard('btc');
    const select = await screen.findByTestId<HTMLSelectElement>('equity-benchmark-mode');
    expect(select.value).toBe('btc');
    fireEvent.change(select, { target: { value: 'basket' } });
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch).toBeDefined();
      expect(String((patch?.[1] as RequestInit).body)).toContain('basket');
    });
  });
});
