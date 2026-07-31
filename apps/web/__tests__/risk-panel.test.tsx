import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/shared/lib/query-client';
import { RiskPanel } from '@/features/profile/components/risk-panel';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Status {
  halted: boolean;
  todayRealizedPnl: string;
  limitQuote: string | null;
  resetsAtMs: number | null;
}
const dashboard = (status: Status, configInvalid = false) => ({
  config: { dailyLossLimitQuote: status.limitQuote ?? '0' },
  configInvalid,
  quoteAsset: 'USDT',
  status,
});

const setUp = (body: unknown): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(json(body))),
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RiskPanel profileId="p1" />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RiskPanel', () => {
  it('shows the Off state with no limit', async () => {
    setUp(dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: null, resetsAtMs: null }));
    expect(await screen.findByTestId('risk-off-badge')).toBeInTheDocument();
    expect(screen.getByTestId('risk-limit')).toHaveTextContent(/off/i);
  });

  it('shows the Armed state with the configured limit and today’s P/L', async () => {
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '-3.5', limitQuote: '20', resetsAtMs: null }),
    );
    expect(await screen.findByTestId('risk-armed-badge')).toBeInTheDocument();
    expect(screen.getByTestId('risk-limit')).toHaveTextContent(/20.00 USDT/);
    expect(screen.getByTestId('risk-today-pnl')).toHaveTextContent(/-3.50 USDT/);
  });

  it('shows the paused badge and reset time when halted', async () => {
    const resetsAtMs = Date.UTC(2026, 5, 19);
    setUp(dashboard({ halted: true, todayRealizedPnl: '-21', limitQuote: '20', resetsAtMs }));
    expect(await screen.findByTestId('risk-paused-badge')).toBeInTheDocument();
    expect(screen.getByTestId('risk-paused-detail')).toHaveTextContent(/new buys are paused/i);
  });

  it('warns when the stored config is invalid', async () => {
    setUp(
      dashboard({ halted: false, todayRealizedPnl: '0', limitQuote: null, resetsAtMs: null }, true),
    );
    expect(await screen.findByTestId('risk-config-invalid')).toBeInTheDocument();
  });
});
