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
  qc.setQueryData(['account-settings'], { timezone: 'UTC' });
  render(
    <QueryClientProvider client={qc}>
      <TradeArchivePanel profileId={PID} />
    </QueryClientProvider>,
  );
}

// The rendered "N% of P/L" shares of the by-exit-reason band, in row order.
function readIntentShares(): number[] {
  return screen
    .getAllByTestId(/^archive-intent-share-/)
    .map((el) => Number(/^(-?\d+)%/.exec(el.textContent ?? '')?.[1]));
}

// The rendered "N% of P/L" shares of the by-source band, in row order.
function readSourceShares(): number[] {
  return screen
    .getAllByTestId(/^archive-source-share-/)
    .map((el) => Number(/^(-?\d+)%/.exec(el.textContent ?? '')?.[1]));
}

// A period spanning two quote coins, which an operator reaches by editing a profile's `quoteAsset`: positions held in the old coin exit and archive under it while new trades archive under the new one, and the archive query filters by neither. USDT splits 75/25, BTC is a single bucket at 100 — so the list holds two pools that each total 100 and the percentages add to 200.
const TWO_COIN_BY_INTENT: ProfileArchiveListResponse['byIntent'] = [
  {
    quoteAsset: 'USDT',
    intent: 'grid-sell',
    tradeCount: 3,
    wins: 3,
    losses: 0,
    profitSum: '75',
    netProfit: '75',
    grossProfit: '75',
    grossLoss: '0',
    totalFees: '0',
    feeBasis: 'exact',
  },
  {
    quoteAsset: 'USDT',
    intent: 'protective-stop',
    tradeCount: 1,
    wins: 0,
    losses: 1,
    profitSum: '-25',
    netProfit: '-25',
    grossProfit: '0',
    grossLoss: '25',
    totalFees: '0',
    feeBasis: 'exact',
  },
  {
    quoteAsset: 'BTC',
    intent: 'grid-sell',
    tradeCount: 2,
    wins: 2,
    losses: 0,
    profitSum: '1',
    netProfit: '1',
    grossProfit: '1',
    grossLoss: '0',
    totalFees: '0',
    feeBasis: 'exact',
  },
];

// The by-source half of the same period, with the same per-coin splits, so the two bands' equivalent buckets can be compared node for node.
const TWO_COIN_BY_SOURCE: ProfileArchiveListResponse['bySource'] = [
  {
    quoteAsset: 'USDT',
    source: 'auto',
    tradeCount: 3,
    wins: 3,
    losses: 0,
    profitSum: '75',
    netProfit: '75',
    grossProfit: '75',
    grossLoss: '0',
    totalFees: '0',
    feeBasis: 'exact',
  },
  {
    quoteAsset: 'USDT',
    source: 'manual',
    tradeCount: 1,
    wins: 0,
    losses: 1,
    profitSum: '-25',
    netProfit: '-25',
    grossProfit: '0',
    grossLoss: '25',
    totalFees: '0',
    feeBasis: 'exact',
  },
  {
    quoteAsset: 'BTC',
    source: 'auto',
    tradeCount: 2,
    wins: 2,
    losses: 0,
    profitSum: '1',
    netProfit: '1',
    grossProfit: '1',
    grossLoss: '0',
    totalFees: '0',
    feeBasis: 'exact',
  },
];

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

  it('does not call a recovery finished when the response never reported the missing set', async () => {
    // A rollup-only archive response carries no `recoverableSymbols` at all — it did not compute the set. That is a different fact from an empty set, which is the archive saying every coin is accounted for, and only the empty set may end a recovery. Collapsing the two lets a response that answered a different question declare the operator's recovery complete, and the nudge stays gone until something else re-renders it.
    const withoutRecoverable: ProfileArchiveListResponse = {
      items: [],
      nextCursor: null,
      unreconstructableSymbols: [],
      byIntent: [],
      bySource: [],
    };
    fetchProfileArchive
      .mockResolvedValueOnce(response(['BTCUSDT']))
      .mockResolvedValue(withoutRecoverable);
    renderPanel();

    await userEvent.click(await screen.findByTestId('recover-all'));
    await waitFor(() => expect(backfillTradeArchive).toHaveBeenCalledTimes(1));

    // Nothing to name, so no nudge — but no completion claim either.
    await waitFor(() =>
      expect(screen.queryByTestId('archive-missing-nudge')).not.toBeInTheDocument(),
    );
    expect(toastSuccess).not.toHaveBeenCalledWith('Recovery finished.');
  });

  it('does report a recovery finished when the response says the set is empty', async () => {
    // The positive control for the case above. Without it, deleting the success branch or renaming the message leaves that negative assertion passing while the behaviour it guards is gone — an absence assertion cannot tell "correctly silent" from "never speaks".
    fetchProfileArchive
      .mockResolvedValueOnce(response(['BTCUSDT']))
      .mockResolvedValue(response([]));
    renderPanel();

    await userEvent.click(await screen.findByTestId('recover-all'));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Recovery finished.'));
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
          { symbol: 'LUNAUSDT', reason: 'symbol-unavailable', dismissed: false },
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
    expect(within(note).getByTestId('unreconstructable-LUNAUSDT')).toHaveTextContent(
      /no longer lists this coin/,
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
          netProfit: '10',
          grossProfit: '12',
          grossLoss: '2',
          totalFees: '0',
          feeBasis: 'exact',
        },
        // Pure losses -> 0% win, PF 0.
        {
          quoteAsset: 'USDT',
          intent: 'protective-stop',
          tradeCount: 2,
          wins: 0,
          losses: 2,
          profitSum: '-4',
          netProfit: '-4',
          grossProfit: '0',
          grossLoss: '4',
          totalFees: '0',
          feeBasis: 'exact',
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
          netProfit: '-299',
          grossProfit: '1',
          grossLoss: '300',
          totalFees: '0',
          feeBasis: 'exact',
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
          netProfit: '9',
          grossProfit: '9',
          grossLoss: '0',
          totalFees: '0',
          feeBasis: 'exact',
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

  it("gates the History bands on each bucket's own fee tier", async () => {
    // First of the two call sites. Three buckets carrying identical numbers and different tiers, so anything that differs between the three rows is the tier and nothing else.
    const numbers = {
      quoteAsset: 'USDT',
      tradeCount: 5,
      wins: 4,
      losses: 1,
      profitSum: '10',
      netProfit: '10',
      grossProfit: '12',
      grossLoss: '2',
      totalFees: '0',
    };
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      byIntent: [
        { ...numbers, intent: 'grid-sell', feeBasis: 'exact' },
        { ...numbers, intent: 'protective-stop', feeBasis: 'estimated' },
        { ...numbers, intent: 'manual', feeBasis: 'unknown' },
      ],
    });
    renderPanel();

    const exact = await screen.findByTestId('archive-intent-USDT-grid-sell');
    expect(exact).toHaveTextContent('PF 6');
    expect((exact.textContent ?? '').toLowerCase()).not.toContain('estimated');

    const estimated = screen.getByTestId('archive-intent-USDT-protective-stop');
    expect(estimated).toHaveTextContent('PF 6');
    expect((estimated.textContent ?? '').toLowerCase()).toContain('estimated');

    // The fee-independent halves survive; only the ratios OF the fee-adjusted money are withheld.
    const unknown = screen.getByTestId('archive-intent-USDT-manual');
    expect(unknown).toHaveTextContent('5 trades');
    expect(unknown).toHaveTextContent('80% win');
    expect(unknown.textContent ?? '').not.toContain('PF');
    expect(unknown.textContent ?? '').not.toContain('payoff');
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

  it('marks an un-costed row with an accessible unavailable glyph, not a confident +0.00', async () => {
    // The row's `profit` is an honest UNDER-count: a sale with no recorded
    // purchase price contributes nothing. Rendered as a number it reads as a
    // measured break-even, so a real trade looks flat. Only `missingCostBasis`
    // distinguishes the two, and the row next to it proves the flag is not
    // suppressing every P/L.
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      items: [
        {
          id: 'arch-uncosted',
          symbol: 'TSTUSDT',
          exitIntent: 'grid-sell',
          // What the projection really emits for a fully un-costed cycle:
          // `total_buy_quote` is the summed cost basis, which excludes an
          // un-costed SELL, and `total_sell_quote` is derived as buy + profit.
          // Real coins were sold for real money and both columns still read 0.
          totalBuyQuote: '0',
          totalSellQuote: '0',
          profit: '0',
          netProfit: '0',
          feeBasis: 'exact',
          fees: {},
          quoteAsset: 'USDT',
          missingCostBasis: 2,
          archivedAt: '2026-08-10T00:39:37.000Z',
        },
        {
          id: 'arch-costed',
          symbol: 'BTCUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '100',
          totalSellQuote: '110',
          profit: '10',
          netProfit: '9',
          feeBasis: 'exact',
          fees: {},
          quoteAsset: 'USDT',
          missingCostBasis: 0,
          archivedAt: '2026-05-10T05:00:00.000Z',
        },
        {
          id: 'arch-est',
          symbol: 'SOLUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '100',
          totalSellQuote: '110',
          profit: '10',
          netProfit: '9',
          feeBasis: 'estimated',
          fees: { BNB: '0.004' },
          quoteAsset: 'USDT',
          missingCostBasis: 0,
          archivedAt: '2026-05-12T07:00:00.000Z',
        },
      ],
    });
    renderPanel();

    const uncosted = await screen.findByTestId('archive-profit-arch-uncosted');
    // A glyph, not a sentence. The fault rides the accessible name, which is the only channel that survives both a 375px column and a screen reader; the visible mark is `n/a` rather than an em dash because the percent cell beside it already uses the em dash to mean "empty", and one symbol cannot mean both "empty" and "unknowable".
    const marker = within(uncosted).getByTestId('archive-pnl-unavailable-arch-uncosted');
    expect(marker).toHaveAccessibleName('P/L unavailable');
    // Exact, not `toHaveTextContent`: that helper substring-matches, so `n/a` would also be satisfied by the `net n/a` the fee fault renders, and the two marks would stop being distinguishable here.
    expect(marker.textContent).toBe('n/a');
    expect(uncosted).not.toHaveTextContent('0.00');
    // The percent cell is the other half of the same conditional: an em-dash,
    // never a confident +0.00%.
    expect(screen.getByTestId('archive-percent-arch-uncosted')).toHaveTextContent('—');
    expect(screen.getByTestId('archive-percent-arch-uncosted')).not.toHaveTextContent('%');
    // The prose that used to explain the absence is gone. It was the page apologising for a number it could not produce, and it charged the operator a paragraph of vertical space for a fact the marker already carries.
    expect(screen.queryByTestId('archive-pnl-unavailable-note')).not.toBeInTheDocument();

    // The middle tier is a THIRD state beside those two marks and must not be confused with either: the figure is present and usable, so it renders, with the caveat in a word beside it. The costed `exact` row anchors the negative — a marker rendered unconditionally fails here.
    const estimated = within(screen.getByTestId('archive-profit-arch-est')).getByTestId(
      'archive-pnl-estimated-arch-est',
    );
    expect(estimated.textContent).toBe('est');
    expect(estimated).toHaveAttribute('title', expect.stringMatching(/reconstructed/i));
    expect(screen.getByTestId('archive-profit-arch-est')).toHaveTextContent('9');
    expect(screen.queryByTestId('archive-pnl-estimated-arch-costed')).not.toBeInTheDocument();

    // `total_buy_quote` is the summed cost basis, which EXCLUDES an un-costed
    // SELL, and `total_sell_quote` is derived as buy + profit — so both cells
    // under-count on this row. What is pinned here is only that they still
    // render the projection's own zeros: nothing on the page states that they
    // under-count, and the marker beside them does not say so either.
    expect(screen.getByTestId('archive-buy-arch-uncosted')).toHaveTextContent('0');
    expect(screen.getByTestId('archive-sell-arch-uncosted')).toHaveTextContent('0');

    // The fully-costed row still renders its number, and a real percentage. Both
    // read on the SAME basis: default is net, so the percent is netProfit over
    // cost basis (9/100), not the gross 10/100 sitting beside a net amount.
    expect(screen.getByTestId('archive-profit-arch-costed')).toHaveTextContent('9.00');
    expect(screen.getByTestId('archive-percent-arch-costed')).toHaveTextContent('9.00%');
    expect(screen.queryByTestId('archive-pnl-unavailable-arch-costed')).not.toBeInTheDocument();
  });

  it('reads the fully-costed row gross when the toggle says Gross', async () => {
    // The gross half of the pair above, on the identical fixture. Without it,
    // retargeting the net assertion would leave nothing pinning the other
    // basis, and a percent hard-wired to either one would still pass.
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      items: [
        {
          id: 'arch-costed',
          symbol: 'BTCUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '100',
          totalSellQuote: '110',
          profit: '10',
          netProfit: '9',
          feeBasis: 'exact',
          fees: {},
          quoteAsset: 'USDT',
          missingCostBasis: 0,
          archivedAt: '2026-05-10T05:00:00.000Z',
        },
      ],
    });
    renderPanel();

    await userEvent.click(await screen.findByTestId('pnl-basis-gross'));

    expect(screen.getByTestId('archive-profit-arch-costed')).toHaveTextContent('10.00');
    expect(screen.getByTestId('archive-percent-arch-costed')).toHaveTextContent('10.00%');
  });

  it('moves BOTH the P/L amount and the P/L% when the basis toggles', async () => {
    // A row that actually paid commission: net and gross differ, so a percent
    // that ignores the toggle is visible as a percent that does not move while
    // the amount beside it does.
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      items: [
        {
          id: 'arch-fee',
          symbol: 'ETHUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '200',
          totalSellQuote: '220',
          profit: '20',
          netProfit: '17',
          feesQuote: '3',
          feeBasis: 'exact',
          fees: { USDT: '3' },
          quoteAsset: 'USDT',
          missingCostBasis: 0,
          archivedAt: '2026-05-10T05:00:00.000Z',
        },
      ],
    });
    renderPanel();

    const netAmount = (await screen.findByTestId('archive-profit-arch-fee')).textContent;
    const netPercent = screen.getByTestId('archive-percent-arch-fee').textContent;

    await userEvent.click(screen.getByTestId('pnl-basis-gross'));

    const grossAmount = screen.getByTestId('archive-profit-arch-fee').textContent;
    const grossPercent = screen.getByTestId('archive-percent-arch-fee').textContent;

    expect(grossAmount).not.toBe(netAmount);
    expect(grossPercent).not.toBe(netPercent);

    // And the concrete numbers, so "it moved" cannot be satisfied by moving to
    // the wrong basis: 17/200 net, 20/200 gross.
    expect(netAmount).toContain('17.00');
    expect(netPercent).toContain('8.50%');
    expect(grossAmount).toContain('20.00');
    expect(grossPercent).toContain('10.00%');
  });

  it('shows incomplete Net P/L as unavailable while retaining raw fees and Recorded P/L', async () => {
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      items: [
        {
          id: 'arch-incomplete-fee',
          symbol: 'ETHBTC',
          exitIntent: 'grid-sell',
          totalBuyQuote: '0.1',
          totalSellQuote: '0.11',
          profit: '0.01',
          netProfit: '0.01',
          feesQuote: '0',
          feeBasis: 'unknown',
          fees: { BNB: '0.002' },
          quoteAsset: 'BTC',
          missingCostBasis: 0,
          archivedAt: '2026-08-25T00:00:00.000Z',
        },
      ],
    });
    renderPanel();

    const incomplete = await screen.findByTestId('archive-profit-arch-incomplete-fee');
    // A different glyph from the un-costed row, and a different accessible name. The two faults have different remedies — this one clears with a fee reconcile, that one never clears — so the mark has to separate them on both channels: a sighted phone reader has no way to reach an accessible name.
    const marker = within(incomplete).getByTestId('archive-pnl-unavailable-arch-incomplete-fee');
    expect(marker).toHaveAccessibleName('Net P/L unavailable');
    expect(marker.textContent).toBe('net n/a');
    expect(screen.getByTestId('archive-fees-arch-incomplete-fee')).toHaveTextContent('0.002 BNB');
    expect(screen.queryByTestId('archive-pnl-unavailable-note')).not.toBeInTheDocument();
    // The History page no longer points at a control that lives on a different surface. Manage profile still owns the live Reconcile-fees mutation; a dead pointer to it is what got deleted.
    expect(screen.queryAllByText(/Reconcile fees/i)).toHaveLength(0);

    await userEvent.click(screen.getByTestId('pnl-basis-gross'));
    expect(screen.getByTestId('archive-profit-arch-incomplete-fee')).toHaveTextContent('0.01');
    expect(screen.getByText('Recorded P/L')).toBeInTheDocument();
  });

  it('computes the by-exit-reason shares on the selected basis, and they total 100', async () => {
    // Gross and net are deliberately NOT proportional (each bucket pays a
    // different fee), so a share wired to one basis is wrong under the other.
    // The gross split is 39.4 / 24.4 / 36.2 — three independent Math.rounds
    // give 39 + 24 + 36 = 99, so the total is a real constraint, not a
    // formality.
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      byIntent: [
        {
          quoteAsset: 'USDT',
          intent: 'grid-sell',
          tradeCount: 10,
          wins: 8,
          losses: 2,
          profitSum: '394',
          netProfit: '380',
          grossProfit: '420',
          grossLoss: '40',
          totalFees: '14',
          feeBasis: 'exact',
        },
        {
          quoteAsset: 'USDT',
          intent: 'protective-stop',
          tradeCount: 6,
          wins: 1,
          losses: 5,
          profitSum: '-244',
          netProfit: '-288',
          grossProfit: '12',
          grossLoss: '300',
          totalFees: '44',
          feeBasis: 'exact',
        },
        {
          quoteAsset: 'USDT',
          intent: 'discovery-time-stop',
          tradeCount: 7,
          wins: 5,
          losses: 2,
          profitSum: '362',
          netProfit: '350',
          grossProfit: '390',
          grossLoss: '40',
          totalFees: '12',
          feeBasis: 'exact',
        },
      ],
    });
    renderPanel();

    await screen.findByTestId('archive-by-intent');
    const netShares = readIntentShares();

    await userEvent.click(screen.getByTestId('pnl-basis-gross'));
    const grossShares = readIntentShares();

    // Every bucket in the group is a portion of the same whole, so the parts
    // must add up to the whole under either basis.
    expect(netShares.reduce((a, b) => a + b, 0)).toBe(100);
    expect(grossShares.reduce((a, b) => a + b, 0)).toBe(100);

    // The share is a portion of net P/L or of gross P/L — never the same one twice.
    expect(grossShares).not.toEqual(netShares);
  });

  it('withholds all Net shares in a quote group when one exit bucket is incomplete', async () => {
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      byIntent: [
        {
          quoteAsset: 'USDT',
          intent: 'grid-sell',
          tradeCount: 1,
          wins: 1,
          losses: 0,
          profitSum: '75',
          netProfit: '70',
          grossProfit: '75',
          grossLoss: '0',
          totalFees: '5',
          feeBasis: 'exact',
        },
        {
          quoteAsset: 'USDT',
          intent: 'protective-stop',
          tradeCount: 1,
          wins: 0,
          losses: 1,
          profitSum: '-25',
          netProfit: '-25',
          grossProfit: '0',
          grossLoss: '25',
          totalFees: '0',
          feeBasis: 'unknown',
        },
      ],
    });
    renderPanel();
    const shares = await screen.findAllByTestId(/^archive-intent-share-/);
    expect(shares).toHaveLength(2);
    // A share is withheld only ever by incomplete fee evidence, so it carries the fee mark the rows use for that same fault. Plain `n/a` would claim the unrecoverable-history fault instead, and would send the operator looking for a remedy that does not apply.
    for (const share of shares) {
      const marker = within(share).getByRole('img');
      expect(marker).toHaveAccessibleName('Share of P/L unavailable, USDT fee evidence incomplete');
      expect(marker.textContent).toBe('net n/a');
    }

    // The amount is withheld per bucket, so only the incomplete one carries a marker and the complete one keeps its number. Its glyph is pinned separately from its name: the name comes from `unavailablePnlLabel`, which a glyph swapped to the cost-basis mark would not disturb.
    const stopMarker = within(screen.getByTestId('archive-intent-USDT-protective-stop')).getByRole(
      'img',
      { name: 'Net P/L unavailable' },
    );
    expect(stopMarker.textContent).toBe('net n/a');
    const sellRow = screen.getByTestId('archive-intent-USDT-grid-sell');
    expect(
      within(sellRow).queryByRole('img', { name: 'Net P/L unavailable' }),
    ).not.toBeInTheDocument();
    expect(sellRow).toHaveTextContent(/\+70\.00\s*USDT/);

    await userEvent.click(screen.getByTestId('pnl-basis-gross'));
    expect(readIntentShares()).toEqual([75, 25]);
  });

  it('computes the by-source shares on the selected basis, and they total 100', async () => {
    // The two sources pay very different fees, so gross 300/100 splits 75/25 while net 297/60 splits 83/17. A share wired to one basis is visibly wrong under the other, and 83 + 16 is 99 before the leftover point is handed out, so the total is a real constraint.
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      bySource: [
        {
          quoteAsset: 'USDT',
          source: 'auto',
          tradeCount: 9,
          wins: 7,
          losses: 2,
          profitSum: '300',
          netProfit: '297',
          grossProfit: '320',
          grossLoss: '20',
          totalFees: '3',
          feeBasis: 'exact',
        },
        {
          quoteAsset: 'USDT',
          source: 'manual',
          tradeCount: 12,
          wins: 5,
          losses: 7,
          profitSum: '100',
          netProfit: '60',
          grossProfit: '260',
          grossLoss: '160',
          totalFees: '40',
          feeBasis: 'exact',
        },
      ],
    });
    renderPanel();

    await screen.findByTestId('archive-by-source');
    const netShares = readSourceShares();

    await userEvent.click(screen.getByTestId('pnl-basis-gross'));
    const grossShares = readSourceShares();

    // Every bucket in the group is a portion of the same whole, so the parts must add up to the whole under either basis.
    expect(netShares.reduce((a, b) => a + b, 0)).toBe(100);
    expect(grossShares.reduce((a, b) => a + b, 0)).toBe(100);

    // The share is a portion of net P/L or of gross P/L — never the same one twice.
    expect(netShares).toEqual([83, 17]);
    expect(grossShares).toEqual([75, 25]);
  });

  it('withholds all Net shares in a quote group when one source bucket is incomplete', async () => {
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      bySource: [
        {
          quoteAsset: 'USDT',
          source: 'auto',
          tradeCount: 1,
          wins: 1,
          losses: 0,
          profitSum: '75',
          netProfit: '70',
          grossProfit: '75',
          grossLoss: '0',
          totalFees: '5',
          feeBasis: 'exact',
        },
        {
          quoteAsset: 'USDT',
          source: 'manual',
          tradeCount: 1,
          wins: 0,
          losses: 1,
          profitSum: '-25',
          netProfit: '-25',
          grossProfit: '0',
          grossLoss: '25',
          totalFees: '0',
          feeBasis: 'unknown',
        },
      ],
    });
    renderPanel();
    const shares = await screen.findAllByTestId(/^archive-source-share-/);
    expect(shares).toHaveLength(2);
    for (const share of shares) {
      const marker = within(share).getByRole('img');
      expect(marker).toHaveAccessibleName('Share of P/L unavailable, USDT fee evidence incomplete');
      expect(marker.textContent).toBe('net n/a');
    }

    // The two withholdings have different scopes, and only the complete bucket can tell them apart: its own net amount survives because the amount is withheld per bucket, while its share is gone because the share is withheld across the whole quote coin. Queried by accessible name because both markers carry the same fee mark, so the name is the only thing separating a withheld amount from a withheld share.
    const autoRow = screen.getByTestId('archive-source-USDT-auto');
    expect(
      within(autoRow).queryByRole('img', { name: 'Net P/L unavailable' }),
    ).not.toBeInTheDocument();
    // Net 70 rather than Recorded 75: the surviving amount still has to be the one the basis selected.
    expect(autoRow).toHaveTextContent(/\+70\.00\s*USDT/);
    const manualMarker = within(screen.getByTestId('archive-source-USDT-manual')).getByRole('img', {
      name: 'Net P/L unavailable',
    });
    expect(manualMarker).toBeInTheDocument();
    // The glyph, separately from the name: the name comes from `unavailablePnlLabel`, so on its own it cannot catch an amount mark swapped to the cost-basis glyph, which would send the operator after a remedy that does not apply to a fee gap.
    expect(manualMarker.textContent).toBe('net n/a');

    await userEvent.click(screen.getByTestId('pnl-basis-gross'));
    expect(readSourceShares()).toEqual([75, 25]);
  });

  it('names each share’s coin in BOTH bands when the period spans two quote coins', async () => {
    // Two pools, each apportioned to 100 within its own coin, rendered as one flat list: 75 + 25 + 100 reads as 200% of something. The coin is the only thing that tells the operator these are two denominators rather than one broken sum.
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      byIntent: TWO_COIN_BY_INTENT,
      bySource: TWO_COIN_BY_SOURCE,
    });
    renderPanel();

    await screen.findByTestId('archive-by-intent');
    expect(screen.getByTestId('archive-intent-share-USDT-grid-sell')).toHaveTextContent(
      '75% of USDT P/L',
    );
    expect(screen.getByTestId('archive-intent-share-USDT-protective-stop')).toHaveTextContent(
      '25% of USDT P/L',
    );
    expect(screen.getByTestId('archive-intent-share-BTC-grid-sell')).toHaveTextContent(
      '100% of BTC P/L',
    );

    expect(screen.getByTestId('archive-source-share-USDT-auto')).toHaveTextContent(
      '75% of USDT P/L',
    );
    expect(screen.getByTestId('archive-source-share-USDT-manual')).toHaveTextContent(
      '25% of USDT P/L',
    );
    expect(screen.getByTestId('archive-source-share-BTC-auto')).toHaveTextContent(
      '100% of BTC P/L',
    );

    // Structural parity, not two copies of one sentence held in step by review: equivalent buckets in the two bands must render the same node. Class as well as text, because the drift that matters is not only the wording — a band that grew its own span would be free to size or colour the share differently.
    for (const [intentTestId, sourceTestId] of [
      ['archive-intent-share-USDT-grid-sell', 'archive-source-share-USDT-auto'],
      ['archive-intent-share-USDT-protective-stop', 'archive-source-share-USDT-manual'],
      ['archive-intent-share-BTC-grid-sell', 'archive-source-share-BTC-auto'],
    ] as const) {
      const intentShare = screen.getByTestId(intentTestId);
      const sourceShare = screen.getByTestId(sourceTestId);
      expect(sourceShare.className).toBe(intentShare.className);
      expect(sourceShare.textContent).toBe(intentShare.textContent);
    }
  });

  it('leaves the wording unadorned in both bands when one coin covers the whole period', async () => {
    // The counterpart of the test above, and the reason the flag is computed over the whole bucket list rather than asked per bucket: naming the coin on a single-coin archive is noise on the surface an operator reads most.
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      byIntent: TWO_COIN_BY_INTENT.filter((b) => b.quoteAsset === 'USDT'),
      bySource: TWO_COIN_BY_SOURCE.filter((b) => b.quoteAsset === 'USDT'),
    });
    renderPanel();

    await screen.findByTestId('archive-by-intent');
    const intentShare = screen.getByTestId('archive-intent-share-USDT-grid-sell');
    expect(intentShare).toHaveTextContent('75% of P/L');
    expect(intentShare.textContent).not.toContain('USDT');
    const sourceShare = screen.getByTestId('archive-source-share-USDT-auto');
    expect(sourceShare).toHaveTextContent('75% of P/L');
    expect(sourceShare.textContent).not.toContain('USDT');
  });

  it.each([
    ['one quote coin', true],
    ['two quote coins', false],
  ])(
    'keeps the withheld-share mark identical in both bands across %s',
    async (_label, singleCoinOnly) => {
      // A withheld share has no denominator to name, so the coin count must not reach it. Both counts are asserted because the wording is chosen at one site: a fix that appended the coin to the VISIBLE mark would produce "net n/a USDT" on the very rows that have no share to attribute. The accessible name does name the coin, and is asserted here too precisely because that is the one channel where the coin belongs: it says whose evidence is missing, and it must say the same thing whether or not a second coin happens to be in the list.
      const withhold = <T extends { quoteAsset: string; feeBasis: string }>(
        rows: readonly T[],
      ): T[] =>
        rows
          .filter((b) => !singleCoinOnly || b.quoteAsset === 'USDT')
          .map((b) => (b.quoteAsset === 'USDT' ? { ...b, feeBasis: 'unknown' } : b));

      fetchProfileArchive.mockResolvedValue({
        ...response([]),
        byIntent: withhold(TWO_COIN_BY_INTENT),
        bySource: withhold(TWO_COIN_BY_SOURCE),
      });
      renderPanel();

      await screen.findByTestId('archive-by-intent');
      for (const testId of [
        'archive-intent-share-USDT-grid-sell',
        'archive-source-share-USDT-auto',
      ]) {
        const marker = within(screen.getByTestId(testId)).getByRole('img');
        expect(marker.textContent).toBe('net n/a');
        expect(marker).toHaveAccessibleName(
          'Share of P/L unavailable, USDT fee evidence incomplete',
        );
        expect(screen.getByTestId(testId).textContent).not.toContain('USDT P/L');
      }
      if (!singleCoinOnly) {
        // The other coin in the same list still resolved, which is what makes this a MULTI-coin withholding rather than a list with nothing left in it to name.
        expect(screen.getByTestId('archive-intent-share-BTC-grid-sell')).toHaveTextContent(
          '100% of BTC P/L',
        );
      }
    },
  );

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
          feeBasis: 'exact',
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

  it('renders every archive cell as plain decimal and every P/L% at 2dp', async () => {
    // Three separate leaks in one table, all from a cell that prints a contract string verbatim instead of formatting it. decimal.js flips to exponential once a value's decimal exponent reaches -7, meaning any magnitude below 1e-6, so a real commission arrives from the API as `3.6e-7` and reads as an error code beside `0.002`. The P/L% is a ratio pushed through the money formatter, which keeps 8 digits below 1 — so `-0.52246604%` sits directly under `+18.54%`. And an 18-significant-figure buy total is a number nobody can compare against the one on the row below it.
    fetchProfileArchive.mockResolvedValue({
      ...response([]),
      items: [
        {
          id: 'arch-btc-fee',
          symbol: 'ETHBTC',
          exitIntent: 'grid-sell',
          totalBuyQuote: '0.000307064092664099',
          // Both quote totals carry more than 8 decimals on purpose: this is the only row where the Buy and Sell formatters are observable at all, since every other fixture value is already short enough to survive raw interpolation unchanged.
          totalSellQuote: '0.000364198273645192',
          profit: '0.000056935907335901',
          netProfit: '0.000056935907335901',
          feeBasis: 'exact',
          fees: { BTC: '3.6e-7' },
          quoteAsset: 'BTC',
          missingCostBasis: 0,
          archivedAt: '2026-08-10T00:39:37.000Z',
        },
        {
          id: 'arch-dust-fee',
          symbol: 'BNBUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '100',
          totalSellQuote: '110',
          profit: '10',
          netProfit: '10',
          feeBasis: 'exact',
          // A fee at Binance's smallest step. It must survive as a nonzero number rather than rounding away to `0`, which would read as "no commission was paid".
          fees: { BNB: '1e-8' },
          quoteAsset: 'USDT',
          missingCostBasis: 0,
          archivedAt: '2026-08-10T00:40:00.000Z',
        },
        {
          id: 'arch-neg',
          symbol: 'ADAUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '100',
          totalSellQuote: '99.47753396',
          profit: '-0.52246604',
          netProfit: '-0.52246604',
          feeBasis: 'exact',
          fees: {},
          quoteAsset: 'USDT',
          missingCostBasis: 0,
          archivedAt: '2026-08-10T00:41:00.000Z',
        },
        {
          id: 'arch-negzero',
          symbol: 'XRPUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '100',
          totalSellQuote: '99.999',
          profit: '-0.001',
          netProfit: '-0.001',
          feeBasis: 'exact',
          fees: {},
          quoteAsset: 'USDT',
          missingCostBasis: 0,
          archivedAt: '2026-08-10T00:42:00.000Z',
        },
        {
          id: 'arch-pos',
          symbol: 'SOLUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '100',
          totalSellQuote: '100.5',
          profit: '0.5',
          netProfit: '0.5',
          feeBasis: 'exact',
          fees: {},
          quoteAsset: 'USDT',
          missingCostBasis: 0,
          archivedAt: '2026-08-10T00:43:00.000Z',
        },
        {
          id: 'arch-poszero',
          symbol: 'DOTUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '100',
          totalSellQuote: '100.0004',
          profit: '0.0004',
          netProfit: '0.0004',
          feeBasis: 'exact',
          fees: {},
          quoteAsset: 'USDT',
          missingCostBasis: 0,
          archivedAt: '2026-08-10T00:45:00.000Z',
        },
        {
          id: 'arch-none',
          symbol: 'TSTUSDT',
          exitIntent: 'grid-sell',
          totalBuyQuote: '0',
          totalSellQuote: '0',
          profit: '0',
          netProfit: '0',
          feeBasis: 'exact',
          fees: {},
          quoteAsset: 'USDT',
          missingCostBasis: 2,
          archivedAt: '2026-08-10T00:44:00.000Z',
        },
      ],
      // The bands live outside the table, so they need their own sub-microunit values: one bucket whose expectancy lands there, one whose profit factor does. Without both, reverting either band formatter leaves this case green.
      byIntent: [
        {
          quoteAsset: 'USDT',
          intent: 'grid-sell',
          tradeCount: 1,
          wins: 1,
          losses: 0,
          profitSum: '0.00000036',
          netProfit: '0.00000036',
          grossProfit: '0.00000036',
          grossLoss: '0',
          totalFees: '0',
          feeBasis: 'exact',
        },
        {
          quoteAsset: 'USDT',
          intent: 'protective-stop',
          tradeCount: 2,
          wins: 1,
          losses: 1,
          profitSum: '-9.9999964',
          netProfit: '-9.9999964',
          grossProfit: '0.0000036',
          grossLoss: '10',
          totalFees: '0',
          feeBasis: 'exact',
        },
      ],
    });
    renderPanel();

    await screen.findByTestId('archive-percent-arch-btc-fee');

    // Substring matching would pass on the unformatted string too (`0.000307064092664099` contains `0.00030706`), so these anchor the WHOLE cell.
    expect(screen.getByTestId('archive-buy-arch-btc-fee').textContent).toMatch(
      /^0\.00030706\s*BTC$/,
    );
    expect(screen.getByTestId('archive-sell-arch-btc-fee').textContent).toMatch(
      /^0\.0003642\s*BTC$/,
    );
    expect(screen.getByTestId('archive-fees-arch-btc-fee').textContent).toMatch(
      /^0\.00000036\s*BTC$/,
    );
    expect(screen.getByTestId('archive-fees-arch-dust-fee').textContent).toMatch(
      /^0\.00000001\s*BNB$/,
    );

    // A percent is 2dp with a `+` only when strictly positive, and a value that rounds to zero from below is `0.00%`: `-0.00%` reads as a sign glitch, not a loss.
    expect(screen.getByTestId('archive-percent-arch-btc-fee').textContent).toBe('+18.54%');
    expect(screen.getByTestId('archive-percent-arch-dust-fee').textContent).toBe('+10.00%');
    expect(screen.getByTestId('archive-percent-arch-neg').textContent).toBe('-0.52%');
    expect(screen.getByTestId('archive-percent-arch-negzero').textContent).toBe('0.00%');
    expect(screen.getByTestId('archive-percent-arch-pos').textContent).toBe('+0.50%');
    // The mirror of `arch-negzero`, and deliberately NOT symmetric: the sign is chosen from the raw value before the magnitude is rounded, so a tiny gain keeps its `+` while a tiny loss loses its `-`. A signed zero reads as a glitch; a signed-positive zero reads as "we made a little", which is true.
    expect(screen.getByTestId('archive-percent-arch-poszero').textContent).toBe('+0.00%');
    // An un-costed row has no percentage at all, so it keeps the dash and gains no `%`.
    expect(screen.getByTestId('archive-percent-arch-none').textContent).toBe('—');

    // The sweep: no cell anywhere in the table may carry an exponent, whichever column a future field lands in. The count is exact rather than a floor because the claim is about EVERY column: a floor of one row's worth stays green while eight of the nine columns stop rendering, which is precisely the state in which the sweep has stopped covering anything.
    const cells = screen.getAllByRole('cell');
    expect(cells).toHaveLength(7 * 9);
    for (const cell of cells) expect(cell.textContent ?? '').not.toMatch(/e[+-]?\d/);

    // The cell sweep above is blind to the rollup bands: they render as `<ul>/<li>`, so `getAllByRole('cell')` walks straight past an exponent in the expectancy or profit-factor readout. A unit test pins one formatter; this pins the whole rendered surface, so a future band field that formats itself by hand is caught here too.
    //
    // Scanned one text node at a time, not as one flattened string: the band's `· exp …/trade` label sits immediately before the `0% of P/L` share, and concatenating them yields `trade0%`, whose `e0` matches the exponent pattern with nothing wrong. A rendered exponent always lives inside a single text node, so the node boundary removes that false positive without loosening the pattern.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const texts: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      texts.push(node.nodeValue ?? '');
    }
    // A scan over an empty panel, or over one whose bands quietly stopped rendering, proves nothing — so require the band's own markers before the sweep below is allowed to mean anything.
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.join('')).toContain('/trade');
    expect(texts.join('')).toContain('PF ');
    for (const text of texts) expect(text).not.toMatch(/e[+-]?\d/);

    const percents = screen
      .getAllByTestId(/^archive-percent-/)
      .map((cell) => cell.textContent ?? '')
      .filter((text) => text !== '—');
    // Without this the loop below is satisfied by a table that rendered no costed row at all.
    expect(percents).toHaveLength(6);
    for (const text of percents) expect(text).toMatch(/^[+-]?\d+\.\d{2}%$/);
  });
});
