// TradeArchivePanel — the "trade history incomplete" recovery UX. Coins split
// into two lists: `recoverableSymbols` (named as chips under the actionable
// Recover-all warning) and `unreconstructableSymbols` (a quiet reasoned note, no
// button). Covers: chips render from recoverableSymbols, Recover-all fires one
// backfill per coin and self-clears on refetch, the partial-failure banner, the
// unreconstructable note with per-reason gloss, and the free-text fallback.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProfileArchiveListResponse } from '@app/contracts';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
  Toaster: () => null,
}));

const fetchProfileArchive = vi.fn();
const backfillTradeArchive = vi.fn();
const deleteArchiveEntry = vi.fn();
const dismissUnreconstructable = vi.fn();

vi.mock('@/features/profile/api/archive', () => ({
  fetchProfileArchive: (...a: unknown[]) => fetchProfileArchive(...a),
  backfillTradeArchive: (...a: unknown[]) => backfillTradeArchive(...a),
  deleteArchiveEntry: (...a: unknown[]) => deleteArchiveEntry(...a),
  dismissUnreconstructable: (...a: unknown[]) => dismissUnreconstructable(...a),
}));

// Imported after the mock so the panel binds the mocked module.
const { TradeArchivePanel } = await import('@/features/profile/components/trade-archive-panel');

const PID = '00000000-0000-4000-8000-0000000000a1';

const response = (
  recoverable: string[],
  unreconstructable: ProfileArchiveListResponse['unreconstructableSymbols'] = [],
): ProfileArchiveListResponse => ({
  items: [],
  nextCursor: null,
  recoverableSymbols: recoverable,
  unreconstructableSymbols: unreconstructable,
  byIntent: [],
  bySource: [],
});

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TradeArchivePanel profileId={PID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  backfillTradeArchive.mockResolvedValue({ scheduled: true });
  dismissUnreconstructable.mockResolvedValue({ dismissed: true });
});
afterEach(() => vi.clearAllMocks());

describe('<TradeArchivePanel> recovery nudge', () => {
  it('names every missing coin as a chip and offers Recover all N', async () => {
    fetchProfileArchive.mockResolvedValue(response(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']));
    renderPanel();

    const chips = await screen.findByTestId('missing-symbol-chips');
    expect(within(chips).getByTestId('missing-symbol-BTCUSDT')).toBeInTheDocument();
    expect(within(chips).getByTestId('missing-symbol-ETHUSDT')).toBeInTheDocument();
    expect(within(chips).getByTestId('missing-symbol-SOLUSDT')).toBeInTheDocument();
    expect(screen.getByTestId('recover-all')).toHaveTextContent('Recover all 3');
  });

  it('Recover all fires one backfill per coin and clears the nudge on refetch', async () => {
    // First load shows 3 missing; once recovery runs the worker has archived
    // them, so the post-invalidate refetch returns an empty set.
    fetchProfileArchive
      .mockResolvedValueOnce(response(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']))
      .mockResolvedValue(response([]));
    renderPanel();

    await userEvent.click(await screen.findByTestId('recover-all'));

    // One backfill per missing coin.
    await waitFor(() => expect(backfillTradeArchive).toHaveBeenCalledTimes(3));
    expect(backfillTradeArchive).toHaveBeenCalledWith(PID, 'BTCUSDT');
    expect(backfillTradeArchive).toHaveBeenCalledWith(PID, 'ETHUSDT');
    expect(backfillTradeArchive).toHaveBeenCalledWith(PID, 'SOLUSDT');

    // The refetch drains the missing set, so the nudge disappears.
    await waitFor(() =>
      expect(screen.queryByTestId('archive-missing-nudge')).not.toBeInTheDocument(),
    );
  });

  it('surfaces a partial-failure banner, and does not paint over it with success', async () => {
    // The missing set stays non-empty (worker archived nothing), so the
    // fan-out's error banner is the message the operator keeps seeing — the
    // self-clear success branch must not overwrite it.
    fetchProfileArchive.mockResolvedValue(response(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']));
    backfillTradeArchive
      .mockResolvedValueOnce({ scheduled: true })
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValueOnce({ scheduled: true });
    renderPanel();

    await userEvent.click(await screen.findByTestId('recover-all'));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/1 of 3 could not start/)),
    );
  });

  it('keeps the free-text fallback for a coin not in the list', async () => {
    fetchProfileArchive.mockResolvedValue(response([]));
    renderPanel();

    // No nudge when nothing is missing, but the advanced recover-one form stays.
    await waitFor(() => expect(screen.getByTestId('backfill-advanced')).toBeInTheDocument());
    expect(screen.queryByTestId('archive-missing-nudge')).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId('backfill-symbol'), 'wldusdt');
    await userEvent.click(screen.getByTestId('backfill-submit'));
    expect(backfillTradeArchive).toHaveBeenCalledWith(PID, 'WLDUSDT');
  });

  it('shows unrecoverable coins as a quiet note with a reason, not the recover nudge', async () => {
    fetchProfileArchive.mockResolvedValue(
      response(
        [],
        [
          { symbol: 'BTCUSDT', reason: 'open-or-pre-history', dismissed: false },
          { symbol: 'SOLUSDT', reason: 'overshoot', dismissed: false },
          { symbol: 'XRPUSDT', reason: 'orphan-sells', dismissed: false },
        ],
      ),
    );
    renderPanel();

    const note = await screen.findByTestId('archive-unreconstructable-note');
    expect(within(note).getByTestId('unreconstructable-BTCUSDT')).toHaveTextContent(
      /no closed cycle/,
    );
    expect(within(note).getByTestId('unreconstructable-SOLUSDT')).toHaveTextContent(
      /sold more than was bought/,
    );
    expect(within(note).getByTestId('unreconstructable-XRPUSDT')).toHaveTextContent(
      /sold without a recorded buy/,
    );
    // Nothing recoverable → no amber warning and no recover button to dead-end on.
    expect(screen.queryByTestId('archive-missing-nudge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recover-all')).not.toBeInTheDocument();
  });

  it('renders the by-exit-reason and by-source bands with win% and profit factor', async () => {
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      byIntent: [
        // 4 wins / 1 loss, gross 12 vs 2 -> 80% win, PF 6.
        {
          quoteAsset: 'USDT',
          intent: 'grid-sell',
          tradeCount: 5,
          wins: 4,
          losses: 1,
          profitSum: '10',
          grossProfit: '12',
          grossLoss: '2',
        },
        // Pure losses -> 0% win, PF 0.
        {
          quoteAsset: 'USDT',
          intent: 'protective-stop',
          tradeCount: 2,
          wins: 0,
          losses: 2,
          profitSum: '-4',
          grossProfit: '0',
          grossLoss: '4',
        },
        // Small-but-real factor: gross 1 vs 300 -> 0.0033, must NOT round to 0
        // (which is the "no winners" sentinel).
        {
          quoteAsset: 'USDT',
          intent: 'discovery-time-stop',
          tradeCount: 4,
          wins: 1,
          losses: 3,
          profitSum: '-299',
          grossProfit: '1',
          grossLoss: '300',
        },
      ],
      bySource: [
        // All winners, no losers -> profit factor renders as ∞.
        {
          quoteAsset: 'USDT',
          source: 'auto',
          tradeCount: 3,
          wins: 3,
          losses: 0,
          profitSum: '9',
          grossProfit: '9',
          grossLoss: '0',
        },
      ],
    });
    renderPanel();

    const sell = await screen.findByTestId('archive-intent-USDT-grid-sell');
    expect(sell).toHaveTextContent('80% win');
    expect(sell).toHaveTextContent('PF 6');
    const stop = screen.getByTestId('archive-intent-USDT-protective-stop');
    expect(stop).toHaveTextContent('0% win');
    expect(stop).toHaveTextContent('PF 0');

    // A real sub-1 factor keeps significant figures instead of collapsing to 0
    // (which is the "no winners" sentinel).
    const tiny = screen.getByTestId('archive-intent-USDT-discovery-time-stop');
    expect(tiny).toHaveTextContent('25% win');
    expect(tiny).toHaveTextContent('PF 0.0033');

    const auto = screen.getByTestId('archive-source-USDT-auto');
    expect(auto).toHaveTextContent('Discovery (auto-found)');
    expect(auto).toHaveTextContent('100% win');
    expect(auto).toHaveTextContent('PF ∞');
  });

  it('hides a coin on the × and reveals/un-hides it via "Show hidden"', async () => {
    // BTC visible, SOL already hidden — so the note shows BTC + a "Show hidden (1)".
    fetchProfileArchive.mockResolvedValue(
      response(
        [],
        [
          { symbol: 'BTCUSDT', reason: 'open-or-pre-history', dismissed: false },
          { symbol: 'SOLUSDT', reason: 'overshoot', dismissed: true },
        ],
      ),
    );
    renderPanel();

    // Visible list shows only BTC; SOL is collapsed behind the reveal.
    await screen.findByTestId('unreconstructable-BTCUSDT');
    expect(screen.queryByTestId('unreconstructable-SOLUSDT')).not.toBeInTheDocument();

    // Clicking × hides BTC server-side.
    await userEvent.click(screen.getByTestId('unreconstructable-hide-BTCUSDT'));
    expect(dismissUnreconstructable).toHaveBeenCalledWith(PID, 'BTCUSDT', true);

    // "Show hidden (1)" reveals SOL with an un-hide control.
    await userEvent.click(screen.getByTestId('unreconstructable-show-hidden'));
    const hidden = await screen.findByTestId('unreconstructable-hidden-SOLUSDT');
    expect(hidden).toHaveTextContent(/sold more than was bought/);
    await userEvent.click(screen.getByTestId('unreconstructable-unhide-SOLUSDT'));
    expect(dismissUnreconstructable).toHaveBeenCalledWith(PID, 'SOLUSDT', false);
  });

  it('opens the delete-confirm dialog from a row overflow menu', async () => {
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      items: [
        {
          id: 'arch-1',
          symbol: 'BTCUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '100',
          totalSellQuote: '110',
          profit: '10',
          netProfit: '9',
          profitPercent: '10',
          fees: {},
          quoteAsset: 'USDT',
          archivedAt: '2026-05-10T05:00:00.000Z',
        },
      ],
    });
    renderPanel();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('archive-row-actions-arch-1'));
    await user.click(await screen.findByTestId('archive-delete-arch-1'));
    expect(await screen.findByText('Delete archive entry?')).toBeInTheDocument();
    // Gated: the confirm dialog opened, no delete fired yet.
    expect(deleteArchiveEntry).not.toHaveBeenCalled();
  });
});
