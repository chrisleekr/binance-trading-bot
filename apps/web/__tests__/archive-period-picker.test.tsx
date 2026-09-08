// The archive's custom date range: the fifth `Custom` option beside the four presets, and the bounds it puts on the read.
//
// Driven through the panel rather than the picker alone, because the claim under test is that the two inputs reach the SERVER — `from`/`to` were declared on `ArchiveQueryParams` and threaded through both `fetchProfileArchive` and `archiveExportUrl` with no caller that ever set them, which a picker-only test would not have noticed either.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProfileArchiveListResponse } from '@app/contracts';

vi.mock('sonner', () => ({
  toast: { success: () => undefined, error: () => undefined },
  Toaster: () => null,
}));

const fetchProfileArchive = vi.fn();
const archiveExportUrl = vi.fn(() => '/export.ndjson');

// The curve and the audit strip mount inside the panel and issue their own reads; stubbed so these cases stay about the window control.
vi.mock('@/features/dashboard/api/equity-snapshots', () => ({
  fetchEquitySnapshots: () =>
    Promise.resolve({ profileId: 'p', quoteAsset: 'USDT', benchmarkMode: 'btc', points: [] }),
}));
vi.mock('@/features/profile/api/audit-logs', () => ({
  fetchProfileAuditLogs: () => Promise.resolve({ items: [], nextCursor: null }),
  auditLogsExportUrl: () => '/export',
}));

vi.mock('@/features/profile/api/archive', () => ({
  fetchProfileArchive: (...a: unknown[]) => fetchProfileArchive(...a),
  fetchArchiveDetail: (_p: string, id: string) => Promise.resolve({ id, orders: [] }),
  archiveExportUrl: (...a: unknown[]) => archiveExportUrl(...a),
  backfillTradeArchive: vi.fn(),
  deleteArchiveEntry: vi.fn(),
  dismissUnreconstructable: vi.fn(),
}));

const { TradeArchivePanel } = await import('@/features/profile/components/trade-archive-panel');

const PID = '00000000-0000-4000-8000-0000000000a1';

/** One archived cycle, so the pager's buttons render at all — they are mounted only when the page holds rows. */
const ROW: NonNullable<ProfileArchiveListResponse['items']>[number] = {
  id: 'arch-1',
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  totalBuyQuote: '100',
  totalSellQuote: '110',
  profit: '10',
  feesQuote: '1',
  netProfit: '9',
  feeBasis: 'exact',
  fees: {},
  breakdown: {},
  source: 'auto',
  exitIntent: 'grid-sell',
  missingCostBasis: false,
  entryAt: '2026-05-09T05:00:00.000Z',
  exitAt: '2026-05-10T05:00:00.000Z',
  archivedAt: '2026-05-10T05:00:00.000Z',
};

/**
 * The response every case in this file gets back.
 *
 * `from`/`to` are the window the SERVER says it resolved, which is what the picker echoes; they are deliberately not derived from the request, so an echo that quietly rendered the operator's own input instead would read the wrong dates here.
 */
const response = (nextCursor: string | null = null): ProfileArchiveListResponse => ({
  items: [ROW],
  nextCursor,
  recoverableSymbols: [],
  unreconstructableSymbols: [],
  byIntent: [],
  bySource: [],
  from: '2026-05-01T00:00:00.000Z',
  to: '2026-05-31T23:59:59.999Z',
});

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['account-settings'], { timezone: 'UTC' });
  render(
    <QueryClientProvider client={qc}>
      <TradeArchivePanel profileId={PID} />
    </QueryClientProvider>,
  );
}

/** The window on the most recent archive read. Read off the call rather than off the URL, because the export builds its own string and the two have to be shown to agree. */
function lastRequestedWindow(): { from?: string; to?: string; period: string; cursor: unknown } {
  const call = fetchProfileArchive.mock.calls.at(-1);
  return (call?.[1] ?? {}) as { from?: string; to?: string; period: string; cursor: unknown };
}

beforeEach(() => {
  fetchProfileArchive.mockResolvedValue(response());
});
afterEach(() => vi.clearAllMocks());

describe('archive period picker — the custom date range', () => {
  it('keeps the range inputs out of the way until Custom is chosen', async () => {
    renderPanel();
    await screen.findByTestId('archive-period-a');

    // The four presets are unchanged, and the fifth option is beside them.
    for (const preset of ['a', 'd', 'w', 'm']) {
      expect(screen.getByTestId(`archive-period-${preset}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('archive-period-custom')).toBeInTheDocument();
    expect(screen.queryByTestId('archive-custom-range')).toBeNull();

    await userEvent.click(screen.getByTestId('archive-period-custom'));
    expect(await screen.findByTestId('archive-custom-range')).toBeInTheDocument();
    expect(screen.getByTestId('archive-range-from')).toBeInTheDocument();
    expect(screen.getByTestId('archive-range-to')).toBeInTheDocument();
  });

  it('sends the operator’s two dates as the read’s window, the end edge covering its whole day', async () => {
    renderPanel();
    await screen.findByTestId('archive-period-a');
    // Nothing bounds the read until a range is set: a preset resolves its own window server-side.
    expect(lastRequestedWindow().from).toBeUndefined();

    await userEvent.click(screen.getByTestId('archive-period-custom'));
    await userEvent.type(screen.getByTestId('archive-range-from'), '2026-05-01');
    await userEvent.type(screen.getByTestId('archive-range-to'), '2026-05-31');

    await waitFor(() => {
      const w = lastRequestedWindow();
      expect(w.from).toBe('2026-05-01T00:00:00.000Z');
      // Not the day's midnight: the server's range predicate is inclusive, so a bare `2026-05-31T00:00:00Z` would drop every trade archived during the day the operator named as the end of the window.
      expect(w.to).toBe('2026-05-31T23:59:59.999Z');
    });

    // And the export carries the same window, so a downloaded file matches what was on screen.
    const exported = archiveExportUrl.mock.calls.at(-1)?.[1] as { from?: string; to?: string };
    expect(exported.from).toBe('2026-05-01T00:00:00.000Z');
    expect(exported.to).toBe('2026-05-31T23:59:59.999Z');
  });

  it('treats each edge as optional, and stops bounding the read once a preset takes over again', async () => {
    renderPanel();
    await screen.findByTestId('archive-period-a');
    await userEvent.click(screen.getByTestId('archive-period-custom'));
    await userEvent.type(screen.getByTestId('archive-range-from'), '2026-05-01');

    await waitFor(() => {
      const w = lastRequestedWindow();
      expect(w.from).toBe('2026-05-01T00:00:00.000Z');
      // An open end, not the start repeated: "everything since" is a window the operator can ask for.
      expect(w.to).toBeUndefined();
      // And `period` is all-time under a custom window: the server floors an open `from` at `period`'s own start, so a stale preset here would silently narrow the range to this week.
      expect(w.period).toBe('a');
    });

    await userEvent.click(screen.getByTestId('archive-period-w'));
    await waitFor(() => {
      const w = lastRequestedWindow();
      expect(w.period).toBe('w');
      // The typed dates survive the trip out (the inputs keep them), but they no longer scope the read.
      expect(w.from).toBeUndefined();
      expect(w.to).toBeUndefined();
    });
    await userEvent.click(screen.getByTestId('archive-period-custom'));
    expect(await screen.findByTestId('archive-range-from')).toHaveValue('2026-05-01');
  });

  it('refuses to apply an inverted range, and says so rather than failing the load', async () => {
    renderPanel();
    await screen.findByTestId('archive-period-a');
    await userEvent.click(screen.getByTestId('archive-period-custom'));
    await userEvent.type(screen.getByTestId('archive-range-to'), '2026-05-01');
    await userEvent.type(screen.getByTestId('archive-range-from'), '2026-05-31');

    expect(await screen.findByTestId('archive-range-invalid')).toBeInTheDocument();
    await waitFor(() => {
      const w = lastRequestedWindow();
      // The server answers an inverted pair with a 422, which reaches this screen as the ledger's generic "failed to load" and names no date. Held back instead.
      expect(w.from).toBeUndefined();
      expect(w.to).toBeUndefined();
    });
    // No echo while the range is not in force: it would name a window these inputs are not asking for.
    expect(screen.queryByTestId('archive-range-echo')).toBeNull();
  });

  it('echoes the window the RESPONSE reports, not the dates that were typed', async () => {
    // The server resolves the bounds and echoes them back; the picker states those. A control that rendered its own inputs back would agree with itself while disagreeing with the rows below.
    fetchProfileArchive.mockResolvedValue({
      ...response(),
      from: '2026-04-04T00:00:00.000Z',
      to: '2026-04-09T23:59:59.999Z',
    });
    renderPanel();
    await screen.findByTestId('archive-period-a');
    await userEvent.click(screen.getByTestId('archive-period-custom'));
    await userEvent.type(screen.getByTestId('archive-range-from'), '2026-05-01');
    await userEvent.type(screen.getByTestId('archive-range-to'), '2026-05-31');

    const echo = await screen.findByTestId('archive-range-echo');
    await waitFor(() => {
      expect(echo).toHaveTextContent('2026-04-04 00:00 UTC');
      expect(echo).toHaveTextContent('2026-04-09 23:59 UTC');
    });
  });

  it('returns the ledger to page 1 when the window moves', async () => {
    // A keyset boundary and a derived-sort offset both name a position in one particular set, so replaying either against a different window pages through a sequence the operator never saw — which the server refuses with a 422 the ledger can only render as a generic failure.
    fetchProfileArchive.mockResolvedValue(response('cursor-page-2'));
    renderPanel();
    await screen.findByTestId('archive-period-a');
    await userEvent.click(screen.getByTestId('archive-period-custom'));

    await userEvent.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(lastRequestedWindow().cursor).toBe('cursor-page-2'));
    expect(screen.getByText('Page 2')).toBeInTheDocument();

    await userEvent.type(screen.getByTestId('archive-range-from'), '2026-05-01');
    await waitFor(() => {
      expect(lastRequestedWindow().cursor).toBeNull();
      expect(lastRequestedWindow().from).toBe('2026-05-01T00:00:00.000Z');
    });
    expect(screen.getByText('Page 1')).toBeInTheDocument();
  });
});
