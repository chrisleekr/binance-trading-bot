// The per-trade detail sheet: the totals the row already carried, plus the two things only this surface fetches — the orders behind the cycle and whatever the operator changed while it was open.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchArchiveDetail = vi.fn();
const fetchProfileAuditLogs = vi.fn();

vi.mock('@/features/profile/api/archive', () => ({
  fetchArchiveDetail: (...a: unknown[]) => fetchArchiveDetail(...a),
}));
vi.mock('@/features/profile/api/audit-logs', () => ({
  AUDIT_LOG_MAX_LIMIT: 200,
  fetchProfileAuditLogs: (...a: unknown[]) => fetchProfileAuditLogs(...a),
}));

const { ArchiveDetailSheet } = await import('@/features/profile/components/archive-detail-sheet');
const { rowPnl } = await import('@/features/profile/lib/archive-view-model');

const PID = '00000000-0000-4000-8000-0000000000a1';

const ROW = {
  id: 'arch-1',
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  exitIntent: 'grid-sell',
  totalBuyQuote: '100',
  totalSellQuote: '110',
  breakdown: {},
  fees: { USDT: '1' },
  feesQuote: '1',
  feeBasis: 'exact' as const,
  profit: '10',
  netProfit: '9',
  entryAt: '2026-05-09T00:00:00.000Z',
  exitAt: '2026-05-10T06:00:00.000Z',
  missingCostBasis: 0,
  // Deliberately off `exitAt`: a cycle is archived by the sweep that closes it out, not at the instant of its closing sell. Sharing one stamp with `exitAt` would make a hold measured from the archive time indistinguishable from one measured from the exit.
  archivedAt: '2026-05-12T18:00:00.000Z',
};

const renderSheet = (row = ROW): void => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ArchiveDetailSheet
        profileId={PID}
        row={{ ...row, pnl: rowPnl(row, 'net') }}
        timeZone="UTC"
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  );
};

afterEach(() => {
  fetchArchiveDetail.mockReset();
  fetchProfileAuditLogs.mockReset();
});

describe('<ArchiveDetailSheet>', () => {
  it('lists the orders behind the cycle and the changes made while it was open', async () => {
    fetchArchiveDetail.mockResolvedValue({
      id: 'arch-1',
      orders: [
        {
          orderId: 'o-buy',
          binanceOrderId: '1',
          clientOrderId: 'c1',
          intent: 'grid-buy',
          side: 'BUY',
          status: 'FILLED',
          executedQty: '1',
          cummulativeQuoteQty: '100',
          closedAt: '2026-05-09T00:00:00.000Z',
        },
      ],
    });
    fetchProfileAuditLogs.mockResolvedValue({
      items: [
        {
          id: 'a-1',
          event: 'set-symbol-config',
          actor: 'operator',
          payload: {},
          ip: null,
          userAgent: null,
          createdAt: '2026-05-09T12:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    renderSheet();

    const fills = await screen.findByTestId('archive-detail-fills');
    expect(within(fills).getByTestId('archive-detail-fill-o-buy')).toHaveTextContent('grid-buy');
    expect(within(fills).getByTestId('archive-detail-fill-o-buy')).toHaveTextContent('100');

    // Bounded to the cycle's own window, not the whole log: a change made a month later explains nothing about this trade. The limit is the route's maximum, not its UI-sized default: this section claims to list everything the operator changed while the cycle was open, and a 25-row page would answer that claim with the newest 25 and no mark saying so.
    expect(fetchProfileAuditLogs).toHaveBeenCalledWith(
      PID,
      null,
      [],
      { from: ROW.entryAt, to: ROW.exitAt },
      200,
    );
    expect(await screen.findByTestId('archive-detail-during-a-1')).toHaveTextContent(
      'set-symbol-config',
    );
    // The read reached the end of the window, so the list IS everything the heading claims.
    expect(screen.queryByTestId('archive-detail-during-partial')).toBeNull();
  });

  it('marks the list as partial when the window holds changes past the page it read', async () => {
    // The heading says "what you changed while it was open". A page that stopped short answered a narrower question, and a list that simply ends reads as the complete one.
    fetchArchiveDetail.mockResolvedValue({ id: 'arch-1', orders: [] });
    fetchProfileAuditLogs.mockResolvedValue({
      items: [
        {
          id: 'a-1',
          event: 'set-symbol-config',
          actor: 'operator',
          payload: {},
          ip: null,
          userAgent: null,
          createdAt: '2026-05-09T12:00:00.000Z',
        },
      ],
      nextCursor: '2026-05-09T12:00:00.000Z__a-1',
    });
    renderSheet();
    expect(await screen.findByTestId('archive-detail-during-partial')).toHaveTextContent(
      'Only your most recent changes in this window are listed.',
    );
  });

  it('says the orders could not be read instead of showing a cycle with none', async () => {
    fetchArchiveDetail.mockRejectedValue(new Error('boom'));
    fetchProfileAuditLogs.mockResolvedValue({ items: [], nextCursor: null });
    renderSheet();
    // The totals above came off the same row, so a silent empty list would read as "this trade had no orders".
    expect(await screen.findByTestId('archive-detail-fills-error')).toBeInTheDocument();
    expect(screen.queryByTestId('archive-detail-fills')).toBeNull();
  });

  it('asks for no window, and offers no changes section, for a cycle that cannot say when it opened', async () => {
    fetchArchiveDetail.mockResolvedValue({ id: 'arch-1', orders: [] });
    renderSheet({ ...ROW, entryAt: null });
    await screen.findByTestId('archive-detail-hold');
    // A rebuilt cycle has no open time, so it cannot claim which changes happened during it.
    expect(screen.getByTestId('archive-detail-hold')).toHaveTextContent('—');
    // The SECTION is absent, not merely its list. With the section guard removed the query stays disabled, so `isPending` holds and the skeleton renders in place of both queried testids — which is why neither of them is evidence on its own.
    expect(
      screen.queryByRole('heading', { name: 'What you changed while it was open' }),
    ).toBeNull();
    expect(screen.queryByTestId('archive-detail-during-skeleton')).toBeNull();
    expect(screen.queryByTestId('archive-detail-during')).toBeNull();
    expect(screen.queryByTestId('archive-detail-during-none')).toBeNull();
    expect(fetchProfileAuditLogs).not.toHaveBeenCalled();
  });

  it('reports a held duration from the two stamps, not from the archive time', async () => {
    fetchArchiveDetail.mockResolvedValue({ id: 'arch-1', orders: [] });
    fetchProfileAuditLogs.mockResolvedValue({ items: [], nextCursor: null });
    renderSheet();
    // entry → exit is 30h. Measured to `archivedAt` instead it would be 90h, which renders `3.8d`.
    expect(await screen.findByTestId('archive-detail-hold')).toHaveTextContent('1.3d');
    // And the archive time is on the sheet under its own label, so the two stamps are visibly different values rather than one repeated.
    expect(screen.getByTestId('archive-detail-time')).toHaveTextContent('2026-05-12 18:00 UTC');
  });
});
