import type { EquitySnapshotPoint } from '@app/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EquityPnlCard, toSeries } from '@/features/dashboard/components/equity-pnl-card';
import { createQueryClient } from '@/shared/lib/query-client';

const pt = (over: Partial<EquitySnapshotPoint>): EquitySnapshotPoint =>
  ({
    capturedAt: '2026-06-19T00:00:00.000Z',
    netPnlQuote: '0',
    realizedNetQuote: '0',
    positionValueQuote: '0',
    positionCostQuote: '0',
    benchmarkAsset: 'BTC',
    benchmarkPriceQuote: '0',
    ...over,
  }) as EquitySnapshotPoint;

describe('toSeries (profit vs hold)', () => {
  it('is empty for no points', () => {
    expect(toSeries(undefined, 'btc')).toEqual({
      series: [],
      holdWindowPct: null,
      latestNetPnl: null,
      // Nothing plotted is nothing to distrust, matching how the rollup fold reports an empty bucket.
      feeBasis: 'exact',
    });
    expect(toSeries([], 'btc')).toEqual({
      series: [],
      holdWindowPct: null,
      latestNetPnl: null,
      feeBasis: 'exact',
    });
  });

  it('projects the BTC-hold counterfactual from the first deployed point cost and BTC move', () => {
    const out = toSeries(
      [
        pt({ netPnlQuote: '0', positionCostQuote: '1000', benchmarkPriceQuote: '100' }),
        pt({
          capturedAt: '2026-06-19T06:00:00.000Z',
          netPnlQuote: '50',
          positionCostQuote: '1000',
          benchmarkPriceQuote: '110',
        }),
      ],
      'btc',
    );
    // Held 1000 of cost; BTC +10% → hold P/L = 1000 * 0.10 = 100. Bot made 50.
    expect(out.series[1]?.hold).toBeCloseTo(100, 6);
    expect(out.series[1]?.netPnl).toBe(50);
    expect(out.holdWindowPct).toBeCloseTo(10, 6);
    expect(out.latestNetPnl).toBe(50);
  });

  it('rebases net P/L to the anchor so both lines share a zero baseline', () => {
    const out = toSeries(
      [
        pt({ netPnlQuote: '200', positionCostQuote: '1000', benchmarkPriceQuote: '100' }),
        pt({ netPnlQuote: '250', positionCostQuote: '1000', benchmarkPriceQuote: '100' }),
      ],
      'btc',
    );
    expect(out.series[0]?.netPnl).toBe(0);
    expect(out.series[1]?.netPnl).toBe(50);
    // Headline keeps the absolute cumulative figure, not the windowed delta.
    expect(out.latestNetPnl).toBe(250);
  });

  it('anchors to the first point where capital was deployed, dropping pre-deployment points', () => {
    const out = toSeries(
      [
        pt({ positionCostQuote: '0', benchmarkPriceQuote: '100', netPnlQuote: '5' }), // pre-deploy
        pt({ positionCostQuote: '500', benchmarkPriceQuote: '100', netPnlQuote: '10' }), // anchor
        pt({ positionCostQuote: '500', benchmarkPriceQuote: '130', netPnlQuote: '40' }),
      ],
      'btc',
    );
    // The flat pre-deployment point is excluded; the series starts at the anchor.
    expect(out.series).toHaveLength(2);
    expect(out.series[0]?.netPnl).toBe(0); // anchor net rebased to 0
    expect(out.series[1]?.hold).toBeCloseTo(150, 6); // 500 * (130/100 - 1)
    expect(out.holdWindowPct).toBeCloseTo(30, 6); // BTC measured from deployment, not boot
  });

  it('reports no hold window when the benchmark price is missing (0)', () => {
    const out = toSeries(
      [
        pt({ benchmarkPriceQuote: '0', positionCostQuote: '100' }),
        pt({ benchmarkPriceQuote: '0', positionCostQuote: '100' }),
      ],
      'btc',
    );
    expect(out.holdWindowPct).toBeNull();
    expect(out.series.every((p) => p.hold === 0)).toBe(true);
  });

  it('builds the basket-hold line as the equal-weight return of held symbols', () => {
    const out = toSeries(
      [
        pt({
          positionCostQuote: '1000',
          netPnlQuote: '0',
          benchmarkPrices: { ETHUSDT: '2000', SOLUSDT: '100' },
        }),
        pt({
          netPnlQuote: '120',
          positionCostQuote: '1000',
          // ETH +10%, SOL +20% → equal-weight +15%.
          benchmarkPrices: { ETHUSDT: '2200', SOLUSDT: '120' },
        }),
      ],
      'basket',
    );
    expect(out.series[1]?.hold).toBeCloseTo(150, 6); // 1000 * 0.15
    expect(out.holdWindowPct).toBeCloseTo(15, 6);
  });

  it('values the basket over only the symbols present at both ends (a fully-exited coin drops out)', () => {
    const out = toSeries(
      [
        pt({ positionCostQuote: '1000', benchmarkPrices: { ETHUSDT: '2000', SOLUSDT: '100' } }),
        // SOL no longer held → basket return is ETH alone (+10%).
        pt({ positionCostQuote: '1000', benchmarkPrices: { ETHUSDT: '2200' } }),
      ],
      'basket',
    );
    expect(out.series[1]?.hold).toBeCloseTo(100, 6); // 1000 * 0.10
  });

  it('holds the basket line flat when a point has no captured prices (old rows)', () => {
    const out = toSeries(
      [
        pt({ positionCostQuote: '1000', benchmarkPrices: { ETHUSDT: '2000' } }),
        pt({ positionCostQuote: '1000' }), // no benchmarkPrices
      ],
      'basket',
    );
    expect(out.series[1]?.hold).toBe(0);
    expect(out.holdWindowPct).toBeNull();
  });

  it('uses the first point with prices as the basket base when the anchor has none', () => {
    const out = toSeries(
      [
        pt({ positionCostQuote: '1000', netPnlQuote: '0' }), // anchor, no prices (transient gap)
        pt({ positionCostQuote: '1000', benchmarkPrices: { ETHUSDT: '2000' } }), // basket base
        pt({ positionCostQuote: '1000', benchmarkPrices: { ETHUSDT: '2200' } }),
      ],
      'basket',
    );
    // Base is the second point's prices; the third is +10% off it.
    expect(out.series[2]?.hold).toBeCloseTo(100, 6);
  });

  it('drops a basket leg whose base price is 0 (no divide-by-zero)', () => {
    const out = toSeries(
      [
        pt({ positionCostQuote: '1000', benchmarkPrices: { ETHUSDT: '0', SOLUSDT: '100' } }),
        pt({ positionCostQuote: '1000', benchmarkPrices: { ETHUSDT: '2200', SOLUSDT: '120' } }),
      ],
      'basket',
    );
    // ETH base 0 is skipped → return is SOL alone (+20%); result is finite.
    expect(out.series[1]?.hold).toBeCloseTo(200, 6);
    expect(Number.isFinite(out.series[1]?.hold ?? NaN)).toBe(true);
  });

  it('keeps the series with a flat hold line when capital was never deployed', () => {
    const out = toSeries(
      [
        pt({ positionCostQuote: '0', benchmarkPriceQuote: '100', netPnlQuote: '0' }),
        pt({ positionCostQuote: '0', benchmarkPriceQuote: '130', netPnlQuote: '0' }),
      ],
      'btc',
    );
    expect(out.series).toHaveLength(2);
    expect(out.series.every((p) => p.hold === 0)).toBe(true);
  });

  it('handles a single deployed point', () => {
    const out = toSeries(
      [pt({ positionCostQuote: '500', benchmarkPriceQuote: '100', netPnlQuote: '20' })],
      'btc',
    );
    expect(out.series).toHaveLength(1);
    expect(out.series[0]?.netPnl).toBe(0);
    expect(out.latestNetPnl).toBe(20);
  });

  it('reports the window at its WEAKEST point tier, not its newest', () => {
    // The green line is one claim about the whole window, so a single unaccounted point taints it. Ordered weak-then-strong on purpose: a fold that just took the last value would read `exact` here and certify a curve built partly on a total known to be short.
    const out = toSeries(
      [
        pt({ positionCostQuote: '100', feeBasis: 'unknown' }),
        pt({ positionCostQuote: '100', feeBasis: 'exact' }),
      ],
      'btc',
    );
    expect(out.feeBasis).toBe('unknown');
  });

  it('reports estimated when that is the weakest tier plotted', () => {
    // The other half: without it, a fold hardwired to `unknown` would satisfy the case above and mark every reconstructed curve as unaccounted for, which is the tier whose whole meaning is that a charge is MISSING.
    const out = toSeries(
      [
        pt({ positionCostQuote: '100', feeBasis: 'exact' }),
        pt({ positionCostQuote: '100', feeBasis: 'estimated' }),
      ],
      'btc',
    );
    expect(out.feeBasis).toBe('estimated');
  });

  it('ignores the tier of points dropped before the anchor', () => {
    // The fold runs over the PLOTTED window, not the raw response. A pre-deployment point is not on the line, so its evidence cannot be what the line is marked for.
    const out = toSeries(
      [
        pt({ positionCostQuote: '0', feeBasis: 'unknown' }),
        pt({ positionCostQuote: '100', feeBasis: 'exact' }),
      ],
      'btc',
    );
    expect(out.feeBasis).toBe('exact');
  });
});

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
