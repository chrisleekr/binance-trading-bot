// Responsive treatment of the Archive tab. Below `md` the 9-column table is a horizontal scroll strip on a phone, so each trade renders instead as a compact two-line row and the full figures move into a tap-opened detail sheet. Covers: the compact rows themselves, the table staying intact at `md` and above, the detail sheet and its unavailable branches, touch-target sizing, the Delete confirm still being reachable, the loading skeleton, and the two variants' testids staying disjoint.
//
// happy-dom supplies a real `window.matchMedia` answering from its own viewport, which a test cannot cross without resizing the window, and it measures no layout at all. So the FIRST describe below proves which variant is VISIBLE at a given width structurally, by the Tailwind visibility classes each variant carries, and the true no-horizontal-scroll guard lives in the Playwright lane. The second describe installs a fake it can fire `change` on, because the detail sheet portals outside the responsive wrapper and closing it on a breakpoint crossing is the one thing CSS cannot decide.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const { ArchiveCompactList } = await import('@/features/profile/components/archive-compact-list');
const { rowPnl } = await import('@/features/profile/lib/archive-view-model');

const PID = '00000000-0000-4000-8000-0000000000a1';

// One winner, one loser, one row whose P/L could not be worked out — so the
// compact row is exercised on every P/L state the table already renders.
const ROWS = [
  {
    id: 'arch-win',
    symbol: 'BTCUSDT',
    exitIntent: 'grid-sell',
    totalBuyQuote: '100',
    totalSellQuote: '110',
    profit: '10',
    netProfit: '9',
    feesQuote: '1',
    feeBasis: 'exact',
    fees: { USDT: '1' },
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
    feesQuote: '1',
    feeBasis: 'estimated',
    fees: { BNB: '0.004' },
    quoteAsset: 'USDT',
    missingCostBasis: 0,
    archivedAt: '2026-05-12T07:00:00.000Z',
  },
  {
    id: 'arch-loss',
    symbol: 'ETHUSDT',
    exitIntent: 'grid-stop-loss',
    totalBuyQuote: '200',
    totalSellQuote: '180',
    profit: '-20',
    netProfit: '-22',
    feesQuote: '2',
    feeBasis: 'exact',
    fees: { BNB: '0.002' },
    quoteAsset: 'USDT',
    missingCostBasis: 0,
    archivedAt: '2026-05-11T06:30:00.000Z',
  },
  {
    id: 'arch-uncosted',
    symbol: 'TSTUSDT',
    exitIntent: 'grid-sell',
    totalBuyQuote: '0',
    totalSellQuote: '0',
    profit: '0',
    netProfit: '0',
    feesQuote: '0',
    feeBasis: 'exact',
    fees: {},
    quoteAsset: 'USDT',
    missingCostBasis: 2,
    archivedAt: '2026-05-12T07:15:00.000Z',
  },
];

const ROW_IDS = ROWS.map((r) => r.id);

const listResponse = {
  items: ROWS,
  nextCursor: null,
  recoverableSymbols: [],
  unreconstructableSymbols: [],
  byIntent: [],
  bySource: [],
};

/**
 * Mount the panel with display settings already resolved to UTC.
 *
 * @returns The QueryClient backing the render, so a test can invalidate the archive query and drive the same background refetch the app does. Callers that do not need it ignore the value.
 */
function renderPanel(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['account-settings'], { timezone: 'UTC' });
  render(
    <QueryClientProvider client={qc}>
      <TradeArchivePanel profileId={PID} />
    </QueryClientProvider>,
  );
  return qc;
}

/**
 * The element itself or the nearest ancestor carrying every Tailwind class in `tokens`, or null. Written as an attribute-token selector rather than `toHaveClass` because the visibility classes sit on a WRAPPER of the list, and pinning which exact node holds them would over-specify the markup without proving anything more.
 *
 * @param el - The node to start from. It is its own first candidate, so a match on `el` itself counts.
 * @param tokens - Tailwind class names that must ALL be present on one single element — the selectors are concatenated, so this is a conjunction, not a list of alternatives. Reading `['hidden', 'md:block']` as "either" would turn the assertion into one that can never fail, since `hidden` alone would satisfy it.
 * @returns The nearest element carrying every token, or null when no ancestor does.
 */
function visibilityScope(el: Element, tokens: readonly string[]): Element | null {
  return el.closest(tokens.map((t) => `[class~="${t}"]`).join(''));
}

beforeEach(() => {
  fetchProfileArchive.mockResolvedValue(listResponse);
});
afterEach(() => vi.clearAllMocks());

describe('<TradeArchivePanel> below the md breakpoint', () => {
  it('renders a compact non-tabular row per trade below md', async () => {
    renderPanel();

    const cards = await screen.findByTestId('archive-card-list');
    // Non-tabular by construction: a list, and not nested inside the table it replaces.
    expect(cards.tagName).toBe('UL');
    expect(cards.closest('table')).toBeNull();
    expect(visibilityScope(cards, ['md:hidden'])).not.toBeNull();
    expect(within(cards).getAllByRole('listitem')).toHaveLength(ROWS.length);

    // Line 1 is the symbol and the number that matters; line 2 is why it closed
    // and when. All four facts on the row itself, no tap required.
    const win = screen.getByTestId('archive-card-arch-win');
    expect(win).toHaveTextContent('BTCUSDT');
    expect(win).toHaveTextContent('profit-taking');
    expect(win).toHaveTextContent('2026-05-10 05:00 UTC');
    expect(screen.getByTestId('archive-card-profit-arch-win')).toHaveTextContent('9.00');

    // The caveat has to reach the PHONE, which is the whole point of this renderer: a mark only the desktop table carries is a mark most sessions never see. The `exact` row beside it anchors the negative, so a marker rendered on every row fails here too.
    expect(screen.getByTestId('archive-card-pnl-estimated-arch-est')).toHaveTextContent('est');
    expect(screen.queryByTestId('archive-card-pnl-estimated-arch-win')).not.toBeInTheDocument();

    const loss = screen.getByTestId('archive-card-arch-loss');
    expect(loss).toHaveTextContent('ETHUSDT');
    expect(loss).toHaveTextContent('stop-loss');
    expect(screen.getByTestId('archive-card-profit-arch-loss')).toHaveTextContent('22.00');

    // An un-costed row must not read as a measured break-even here either. On a phone the row has no width for a sentence, so the fault rides the marker's accessible name and the visible mark is the compact glyph.
    const cardMarker = screen.getByTestId('archive-card-pnl-unavailable-arch-uncosted');
    expect(cardMarker).toHaveAccessibleName('P/L unavailable');
    // Exact, because `toHaveTextContent` substring-matches and would accept the fee fault's `net n/a` here too.
    expect(cardMarker.textContent).toBe('n/a');
    expect(screen.queryByTestId('archive-card-profit-arch-uncosted')).toBeNull();
  });

  it('keeps the existing 9-column table for md and up, hidden below it', async () => {
    renderPanel();

    const table = await screen.findByTestId('archive-list');
    // The table is not deleted, it is scoped: shown from md up, hidden below.
    expect(visibilityScope(table, ['hidden', 'md:block'])).not.toBeNull();
    // And the compact list is its counterpart, mounted at the same time.
    expect(screen.getByTestId('archive-card-list')).toBeInTheDocument();

    // Every existing column and per-row cell still renders the same values.
    expect(within(table).getAllByRole('columnheader')).toHaveLength(9);
    expect(screen.getByTestId('archive-buy-arch-win')).toHaveTextContent('100');
    expect(screen.getByTestId('archive-sell-arch-win')).toHaveTextContent('110');
    expect(screen.getByTestId('archive-profit-arch-win')).toHaveTextContent('9.00');
    expect(screen.getByTestId('archive-percent-arch-win')).toHaveTextContent('9.00%');
    expect(screen.getByTestId('archive-fees-arch-win')).toHaveTextContent('1 USDT');
    expect(screen.getByTestId('archive-exit-arch-win')).toHaveTextContent('profit-taking');
  });

  it('opens a detail sheet with buy, sell, P/L, fees and time when a compact row is activated', async () => {
    renderPanel();

    await userEvent.click(await screen.findByTestId('archive-card-arch-win'));

    const sheet = await screen.findByTestId('archive-detail-sheet');
    expect(within(sheet).getByTestId('archive-detail-buy')).toHaveTextContent('100');
    expect(within(sheet).getByTestId('archive-detail-sell')).toHaveTextContent('110');
    expect(within(sheet).getByTestId('archive-detail-profit')).toHaveTextContent('9.00');
    expect(within(sheet).getByTestId('archive-detail-percent')).toHaveTextContent('9.00%');
    // Fees are per-asset, the same commission breakdown the table's Fees cell shows.
    expect(within(sheet).getByTestId('archive-detail-fees')).toHaveTextContent('1 USDT');
    expect(within(sheet).getByTestId('archive-detail-time')).toHaveTextContent(
      '2026-05-10 05:00 UTC',
    );
  });

  it('sizes every compact-row control to the 44px touch-target classes', async () => {
    // A class assertion, not a measurement: happy-dom has no layout engine, so the rendered pixel size is only checkable in the Playwright lane. What is provable here is that each control carries the token the app's 44px convention is built on.
    //
    // Every token is anchored on whitespace: an unanchored /min-h-11/ also matches `min-h-110`, which is a different size entirely.
    //
    // Scope note: `h-11 w-11` on the kebab comes from `Button`'s `size="icon"` variant, not from markup in this feature — so that half of the loop guards `ui/button.tsx` against a silent resize. `min-h-11` on the row button is this file's own markup.
    renderPanel();
    await screen.findByTestId('archive-card-list');

    for (const id of ROW_IDS) {
      expect(screen.getByTestId(`archive-card-${id}`).className).toMatch(/(^|\s)min-h-11(\s|$)/);
      const actions = screen.getByTestId(`archive-card-actions-${id}`).className;
      expect(actions).toMatch(/(^|\s)h-11(\s|$)/);
      expect(actions).toMatch(/(^|\s)w-11(\s|$)/);
    }
  });

  it('keeps the per-row Delete reachable below md, still behind the confirm dialog', async () => {
    renderPanel();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('archive-card-actions-arch-win'));
    await user.click(await screen.findByTestId('archive-card-delete-arch-win'));

    // Same gated flow as the table: the confirm opens, nothing is deleted yet.
    expect(await screen.findByText('Delete archive entry?')).toBeInTheDocument();
    expect(deleteArchiveEntry).not.toHaveBeenCalled();
  });

  it('shows a compact-row skeleton below md while the archive loads', async () => {
    // Never resolves, so the panel stays in its loading branch.
    fetchProfileArchive.mockReturnValue(new Promise(() => undefined));
    renderPanel();

    const cardSkeleton = await screen.findByTestId('archive-card-skeleton');
    expect(visibilityScope(cardSkeleton, ['md:hidden'])).not.toBeNull();

    // The table skeleton is the other half of the same split, not a replacement.
    const tableSkeleton = screen.getByTestId('archive-table-skeleton');
    expect(visibilityScope(tableSkeleton, ['hidden', 'md:block'])).not.toBeNull();
  });

  it('keeps compact and table testids disjoint, so every per-row id resolves one node', async () => {
    // Both variants are in the DOM at once (only CSS hides one), so a testid reused across them would make every existing singular `getByTestId` in trade-archive-panel.test.tsx throw on multiple matches. Singular lookups here are the assertion: a collision fails this test loudly.
    renderPanel();
    await screen.findByTestId('archive-card-list');

    for (const id of ROW_IDS) {
      expect(screen.getByTestId(`archive-buy-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`archive-sell-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`archive-percent-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`archive-fees-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`archive-exit-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`archive-row-actions-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`archive-card-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`archive-card-actions-${id}`)).toBeInTheDocument();
    }
    // The two P/L cells that only exist on a costed row.
    expect(screen.getByTestId('archive-profit-arch-win')).toBeInTheDocument();
    expect(screen.getByTestId('archive-card-profit-arch-win')).toBeInTheDocument();
    // And the pair that exists only on the UN-costed path, which the per-row loop above structurally cannot reach. `archive-card-pnl-unavailable-` does not prefix-match `archive-pnl-unavailable-`, and this is where that stays true.
    expect(screen.getByTestId('archive-pnl-unavailable-arch-uncosted')).toBeInTheDocument();
    expect(screen.getByTestId('archive-card-pnl-unavailable-arch-uncosted')).toBeInTheDocument();
  });

  it('reports an un-costed row honestly in the detail sheet, with no fabricated zero', async () => {
    // The sheet-side half of the table test in trade-archive-panel.test.tsx: an un-costed cycle has no amount AND no percentage, so a sheet that renders "0.00" and "0.00%" would turn an unmeasured trade into a confident break-even one on the surface a phone operator actually reads.
    renderPanel();

    await userEvent.click(await screen.findByTestId('archive-card-arch-uncosted'));
    const sheet = await screen.findByTestId('archive-detail-sheet');

    const profit = within(sheet).getByTestId('archive-detail-profit');
    // The third of the three surfaces that render the same row. All three carry the same glyph and the same accessible name, so a reader who taps into the sheet is told exactly what the row already told them.
    const sheetMarker = within(profit).getByRole('img');
    expect(sheetMarker).toHaveAccessibleName('P/L unavailable');
    expect(sheetMarker.textContent).toBe('n/a');
    expect(profit).not.toHaveTextContent('0.00');
    // The other half of the same conditional: an em dash, never a confident +0.00%.
    expect(within(sheet).getByTestId('archive-detail-percent')).toHaveTextContent('—');
    expect(within(sheet).getByTestId('archive-detail-percent')).not.toHaveTextContent('%');
    // No commission was recorded for this cycle, which reads as an em dash rather than a blank cell.
    expect(within(sheet).getByTestId('archive-detail-fees')).toHaveTextContent('—');
  });

  it('follows a background refetch while the sheet is open, instead of freezing the row it opened with', async () => {
    // The sheet holds the open row's ID and re-reads it out of `rows`; it does not capture the row object. The difference is only visible when the underlying row changes while the sheet stays open, which is exactly what a poll or a post-mutation invalidation does. A captured object would still be showing the old number here.
    const qc = renderPanel();

    await userEvent.click(await screen.findByTestId('archive-card-arch-win'));
    const sheet = await screen.findByTestId('archive-detail-sheet');
    expect(within(sheet).getByTestId('archive-detail-profit')).toHaveTextContent('9.00');

    // The worker reconciled fees; the next read of the same page returns a different number for the same row.
    fetchProfileArchive.mockResolvedValue({
      ...listResponse,
      items: ROWS.map((r) => (r.id === 'arch-win' ? { ...r, netProfit: '42' } : r)),
    });
    await qc.invalidateQueries({ queryKey: ['profile', 'archive', PID] });

    await waitFor(() =>
      expect(within(sheet).getByTestId('archive-detail-profit')).toHaveTextContent('42.00'),
    );
  });

  it('renders no time on either compact surface until the display timezone is known', async () => {
    // `ArchiveCompactList` is mounted directly rather than through the panel: the panel's archive query key CONTAINS the timezone, so a timezone that goes undefined changes the key and clears `items` — no rows survive to render, and the state cannot be reached from there. The component's own contract still has to hold, because it takes `timeZone: string | undefined` and the row, the table cell and the sheet must agree on what "unknown" looks like. An em dash on one of the three would read as "this trade has no time" rather than "your zone has not loaded".
    const rows = ROWS.map((row) => ({ ...row, pnl: rowPnl(row, 'net') }));

    // Control first, so the assertions below cannot pass merely because nothing rendered.
    const known = render(
      <ArchiveCompactList rows={rows} timeZone="UTC" onDelete={() => undefined} />,
    );
    expect(screen.getByTestId('archive-card-arch-win')).toHaveTextContent('2026-05-10 05:00 UTC');
    known.unmount();

    render(<ArchiveCompactList rows={rows} timeZone={undefined} onDelete={() => undefined} />);
    expect(screen.getByTestId('archive-card-arch-win').textContent ?? '').not.toMatch(
      /\d{4}-\d{2}-\d{2}/,
    );

    await userEvent.click(screen.getByTestId('archive-card-arch-win'));
    const sheet = await screen.findByTestId('archive-detail-sheet');
    const time = within(sheet).getByTestId('archive-detail-time');
    expect(time.textContent).toBe('');
  });

  it('renders no explainer paragraph about missing data at any width', async () => {
    // The motivating case is 375×667, the narrowest supported viewport and the one where vertical space is scarcest — each explainer was the operator paying a paragraph of scroll for a fact the row's own marker already carries. The assertion is width-independent on purpose: the three paragraphs carried no breakpoint class, so "absent from the DOM at all" is both the stronger claim and the only one happy-dom can actually prove.
    fetchProfileArchive.mockResolvedValue({
      ...listResponse,
      byIntent: [
        {
          quoteAsset: 'USDT',
          intent: 'grid-sell',
          tradeCount: 2,
          wins: 1,
          losses: 1,
          profitSum: '10',
          netProfit: '9',
          grossProfit: '20',
          grossLoss: '10',
          totalFees: '1',
          feeBasis: 'unknown',
        },
      ],
      bySource: [
        {
          quoteAsset: 'USDT',
          source: 'auto',
          tradeCount: 2,
          wins: 1,
          losses: 1,
          profitSum: '10',
          netProfit: '9',
          grossProfit: '20',
          grossLoss: '10',
          totalFees: '1',
          feeBasis: 'unknown',
        },
      ],
    });
    renderPanel();

    // Positive control first: the phone variant is the one this fixture exercises, both bands rendered, and the un-costed row still declares its fault. Without these the absence assertions below would pass on a blank page.
    const cards = await screen.findByTestId('archive-card-list');
    expect(visibilityScope(cards, ['md:hidden'])).not.toBeNull();
    expect(screen.getByTestId('archive-by-intent')).toBeInTheDocument();
    expect(screen.getByTestId('archive-by-source')).toBeInTheDocument();
    expect(screen.getByTestId('archive-card-pnl-unavailable-arch-uncosted')).toHaveAccessibleName(
      'P/L unavailable',
    );

    expect(screen.queryByTestId('archive-pnl-unavailable-note')).not.toBeInTheDocument();
    // Matched against the whole page's text rather than element by element, because the fault is prose narrating an absent number and prose does not care what tag it sits in. An earlier per-element form scanned only childless `p`/`div`/`span`, which silently exempted every paragraph containing inline emphasis — the exact shape of the note this test exists to keep deleted, where the phrase straddled a nested `<span>`.
    const absenceProse =
      /unavailable|P\/L unknown|no record of|fee evidence|Reconcile fees|only count the part|appear only when/i;
    // `rollup-stats-incomplete` is a per-bucket statistics state shared with the Home dashboard, which this change deliberately leaves alone; it is tracked on its own. Cut from a clone by testid rather than skipped by copy, so the exemption stays pinned to that one component instead of pardoning the same words wherever else they appear.
    const clone = document.body.cloneNode(true) as HTMLElement;
    for (const exempt of clone.querySelectorAll('[data-testid="rollup-stats-incomplete"]')) {
      exempt.remove();
    }
    // Whitespace-normalised because JSX joins a wrapped literal with newlines, which would otherwise hide a phrase from a literal-space pattern.
    const pageText = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
    // A coverage anchor, not a count floor: prove the text actually reaches the band region this guard is about. A count of scanned elements would stay comfortably non-zero on layout `div`s alone even if the scan stopped reaching any prose at all.
    expect(pageText).toContain('P/L by exit reason');
    expect(pageText).toContain('P/L by source');
    expect(pageText).not.toMatch(absenceProse);
  });
});

// Crossing the breakpoint WITH the sheet open. The compact list is not unmounted at desktop widths — the `md:hidden` wrapper is display:none at the caller — so the sheet's own state survives the crossing, and `SheetContent` portals to the document body where no ancestor's `hidden` can reach it. What is left over the desktop table is therefore a real, focus-trapped overlay, not a hidden one.
describe('<TradeArchivePanel> across the md breakpoint', () => {
  type ChangeListener = (event: MediaQueryListEvent) => void;

  // The fake's live state, read back by the assertions: `added` is how many `change` subscriptions the component opened, `listeners` is the set still open. A count alone cannot tell "unsubscribed cleanly" from "never subscribed", so both are needed.
  const media = {
    matches: false,
    added: 0,
    queries: [] as string[],
    listeners: new Set<ChangeListener>(),
  };

  /**
   * Install a `matchMedia` whose `change` event a test can fire. happy-dom supplies a real one that answers from its own viewport, so a test cannot cross the breakpoint without resizing the window, and nothing delivers a `change` to a listener.
   *
   * @param matches - Whether the `md` query is satisfied, i.e. whether the viewport is at or above 48rem; false is the phone side of the breakpoint, where the compact list and its sheet are the visible variant.
   */
  const installMatchMedia = (matches: boolean): void => {
    media.matches = matches;
    media.added = 0;
    media.queries = [];
    media.listeners = new Set();
    vi.stubGlobal('matchMedia', (query: string) => {
      media.queries.push(query);
      return {
        media: query,
        get matches() {
          return media.matches;
        },
        onchange: null,
        addEventListener: (type: string, listener: ChangeListener) => {
          if (type !== 'change') return;
          media.added += 1;
          media.listeners.add(listener);
        },
        removeEventListener: (type: string, listener: ChangeListener) => {
          if (type !== 'change') return;
          media.listeners.delete(listener);
        },
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
    });
  };

  /**
   * Drive the query across the breakpoint, exactly as a real resize would: flip `matches`, then deliver a `change` to every open listener.
   *
   * @param matches - The breakpoint state to announce to every registered listener; true is the widen-past-`md` crossing the sheet must close on, false the narrow-back-below one it must ignore.
   */
  const fireChange = (matches: boolean): void => {
    media.matches = matches;
    act(() => {
      for (const listener of media.listeners) listener({ matches } as MediaQueryListEvent);
    });
  };

  beforeEach(() => {
    installMatchMedia(false);
  });
  afterEach(() => {
    // Restores whatever `vi.stubGlobal` displaced, which is happy-dom's own implementation.
    vi.unstubAllGlobals();
  });

  it('subscribes to the same breakpoint the compact list is scoped by, in the same unit', async () => {
    // `md:hidden` compiles to `48rem`, and rem tracks the reader's root font size. A `768px` query matches it only at the 16px default, so on a raised browser font the CSS swaps to the desktop table at a width the JS query has not reached yet — which is this bug, unfixed, for exactly the readers who need the larger layout. Pinned here because nothing else can see the two drift apart.
    renderPanel();
    // The compact list mounts with the loaded archive, not with the panel, so the subscription does not exist until the query resolves.
    await screen.findByTestId('archive-card-list');
    expect(media.queries).toContain('(min-width: 48rem)');
  });

  it('closes the detail sheet when the viewport widens to md, leaving no overlay over the desktop table', async () => {
    renderPanel();
    await userEvent.click(await screen.findByTestId('archive-card-arch-win'));
    expect(await screen.findByTestId('archive-detail-sheet')).toBeInTheDocument();

    fireChange(true);

    // Closed, not hidden: a `md:hidden` on the portalled content would leave this node mounted and still holding focus.
    expect(screen.queryByTestId('archive-detail-sheet')).toBeNull();
    // The table the operator is now looking at is uncovered, which is the whole point of closing.
    expect(screen.getByTestId('archive-list')).toBeInTheDocument();
  });

  it('leaves the sheet open while the viewport stays below md', async () => {
    // The control for the test above: a fix that closed on any `change` event, rather than on the query becoming true, would shut the sheet under the operator on a keyboard opening or an orientation change that never crossed the breakpoint.
    renderPanel();
    await userEvent.click(await screen.findByTestId('archive-card-arch-win'));
    expect(await screen.findByTestId('archive-detail-sheet')).toBeInTheDocument();

    fireChange(false);

    expect(screen.getByTestId('archive-detail-sheet')).toBeInTheDocument();
  });

  it('unsubscribes from the breakpoint query on unmount', async () => {
    renderPanel();
    await screen.findByTestId('archive-card-list');
    // The control half. Asserting only that nothing is subscribed after unmount would pass just as well over a component that never subscribed at all, which is precisely today's state.
    expect(media.added).toBeGreaterThan(0);

    cleanup();

    expect(media.listeners.size).toBe(0);
  });
});
