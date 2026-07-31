import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { SymbolDiscoveryStatus } from '@/features/symbol/components/symbol-discovery-status';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const config = {
  enabled: true,
  refreshPeriodMs: 900_000,
  blacklist: [],
  min24hPairVolumeUsd: '500000',
  min24hAssetVolumeUsd: '50000000',
  maxSpreadRatio: '0.003',
  changeMinPercent: '0',
  rankTopPercent: 30,
  rankExcludeTopPercent: 5,
  minAgeDays: 30,
  maxAutoSymbols: 5,
  minHoldMinutes: 120,
  trendConfirm: {
    adxPeriod: 14,
    adxMin: '25',
    emaPeriod: 20,
    volSmaPeriod: 20,
    volMultiple: '1.5',
  },
};

const baseDashboard = {
  config,
  quoteAsset: 'USDT',
  scoreboard: {
    realizedProfit: '0',
    realizedProfitPercent: '0',
    tradeCount: 0,
    winRate: 0,
    realizedProfit7d: '0',
    tradeCount7d: 0,
  },
  gauge: { deployedQuote: '0', maxAccountExposureQuote: null, autoSymbolCount: 1 },
  universe: null,
  holdings: [],
  autoSymbols: [],
  activity: [],
};

const candidate = (disposition: string) => ({
  symbol: 'WLDUSDT',
  gainerScore: '12',
  passed: ['quote', 'blacklist', 'liquidity', 'spread', 'changeBand', 'age', 'trend'],
  failedAt: null,
  disposition,
});

const setUp = (dashboard: unknown, flat = true): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      return Promise.resolve(
        url.endsWith('/profiles/p1/discovery') ? json(dashboard) : json({}, 404),
      );
    }),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SymbolDiscoveryStatus profileId="p1" symbol="WLDUSDT" flat={flat} />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SymbolDiscoveryStatus', () => {
  it('renders nothing for a symbol discovery does not manage', async () => {
    setUp({ ...baseDashboard, autoSymbols: ['BTCUSDT'] });
    // Give the query a tick to resolve, then assert the panel never appeared.
    await Promise.resolve();
    expect(screen.queryByTestId('symbol-discovery-status')).not.toBeInTheDocument();
  });

  it('says a held coin is never auto-removed while not flat', async () => {
    setUp({ ...baseDashboard, autoSymbols: ['WLDUSDT'] }, false);
    const panel = await screen.findByTestId('symbol-discovery-status');
    expect(panel).toHaveTextContent(/holding this coin/i);
    expect(panel).toHaveTextContent(/won't remove it/i);
  });

  it('warns when a flat coin has faded and its min-hold elapsed', async () => {
    setUp({
      ...baseDashboard,
      autoSymbols: ['WLDUSDT'],
      universe: { computedAtMs: 1, candidates: [candidate('faded-removed')] },
    });
    const panel = await screen.findByTestId('symbol-discovery-status');
    expect(panel).toHaveTextContent(/dropped to cash on the next discovery scan/i);
  });

  it('explains the min-hold wait for a faded-held coin', async () => {
    setUp({
      ...baseDashboard,
      autoSymbols: ['WLDUSDT'],
      universe: { computedAtMs: 1, candidates: [candidate('faded-held')] },
    });
    const panel = await screen.findByTestId('symbol-discovery-status');
    expect(panel).toHaveTextContent(/2h minimum hold/i);
  });

  it('humanizes a sub-hour min-hold as minutes', async () => {
    setUp({
      ...baseDashboard,
      config: { ...config, minHoldMinutes: 45 },
      autoSymbols: ['WLDUSDT'],
    });
    const panel = await screen.findByTestId('symbol-discovery-status');
    expect(panel).toHaveTextContent(/held at least 45 min/i);
  });

  it('humanizes a fractional-hour min-hold with one decimal', async () => {
    setUp({
      ...baseDashboard,
      config: { ...config, minHoldMinutes: 90 },
      autoSymbols: ['WLDUSDT'],
    });
    const panel = await screen.findByTestId('symbol-discovery-status');
    expect(panel).toHaveTextContent(/held at least 1\.5h/i);
  });

  it('reassures a still-trending coin that it stays in rotation', async () => {
    setUp({
      ...baseDashboard,
      autoSymbols: ['WLDUSDT'],
      universe: { computedAtMs: 1, candidates: [candidate('kept')] },
    });
    const panel = await screen.findByTestId('symbol-discovery-status');
    expect(panel).toHaveTextContent(/still trending, so it stays in rotation/i);
  });

  it('notes that a paused profile will not rotate the coin out', async () => {
    setUp({ ...baseDashboard, config: { ...config, enabled: false }, autoSymbols: ['WLDUSDT'] });
    const panel = await screen.findByTestId('symbol-discovery-status');
    expect(panel).toHaveTextContent(/Auto-discovery is paused/i);
  });
});
