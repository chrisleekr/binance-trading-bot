// AccountBalancesPanel covers hide-zero default, search, count, empty state, quote-asset valuation, and value sort.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { AccountBalancesPanel } from '../src/features/profile/components/account-balances-panel.js';

import { asDecimalString, type ProfileDashboardResponse } from '@app/contracts';

type AssetBalance = ProfileDashboardResponse['balances'][number];
type DashboardSymbol = ProfileDashboardResponse['symbols'][number];

const bal = (
  asset: string,
  free: string,
  locked = '0',
  usdPrice: string | null = null,
): AssetBalance => ({
  asset,
  free: asDecimalString(free),
  locked: asDecimalString(locked),
  usdPrice: usdPrice == null ? null : asDecimalString(usdPrice),
});

const sym = (symbol: string, currentPrice: string | null): DashboardSymbol => ({
  symbol,
  enabled: true,
  avgEntryPrice: null,
  currentPrice: currentPrice == null ? null : asDecimalString(currentPrice),
  openOrderCount: 0,
  openOrders: [],
});

// Each priced asset carries its own usdPrice (backend price map): BTC 70000,
// USDT 1:1, ETH 3000, KZT unpriced.
const balances = [
  bal('BTC', '0.5', '0', '70000'),
  bal('USDT', '1200.25', '0', '1'),
  bal('KZT', '0'),
  bal('ETH', '0', '2', '3000'),
];
const symbols = [sym('BTCUSDT', '70000'), sym('ETHUSDT', '3000')];

describe('AccountBalancesPanel', () => {
  it('hides zero balances by default and keeps locked-only assets', () => {
    render(<AccountBalancesPanel balances={balances} symbols={symbols} quoteAsset="USDT" />);
    expect(screen.getByTestId('balance-row-BTC')).toBeInTheDocument();
    // ETH has 0 free but 2 locked — not a zero balance, must stay visible.
    expect(screen.getByTestId('balance-row-ETH')).toBeInTheDocument();
    expect(screen.queryByTestId('balance-row-KZT')).not.toBeInTheDocument();
    expect(screen.getByTestId('balance-count')).toHaveTextContent(
      'Showing 3 of 4 assets (1 zero hidden).',
    );
  });

  it('reveals zero balances when the toggle is switched off', async () => {
    const user = userEvent.setup();
    render(<AccountBalancesPanel balances={balances} symbols={symbols} quoteAsset="USDT" />);
    await user.click(screen.getByLabelText('Hide zero balances'));
    expect(screen.getByTestId('balance-row-KZT')).toBeInTheDocument();
    expect(screen.getByTestId('balance-count')).toHaveTextContent('Showing 4 of 4 assets.');
    expect(screen.queryByTestId('balance-hidden-count')).not.toBeInTheDocument();
  });

  it('filters the list by the search query', async () => {
    const user = userEvent.setup();
    render(<AccountBalancesPanel balances={balances} symbols={symbols} quoteAsset="USDT" />);
    await user.type(screen.getByTestId('balance-search'), 'us');
    expect(screen.getByTestId('balance-row-USDT')).toBeInTheDocument();
    expect(screen.queryByTestId('balance-row-BTC')).not.toBeInTheDocument();
    // Search narrows to 1 row; the hide-zero counter excludes the search-
    // filtered rows, not just the zero-balance ones.
    expect(screen.getByTestId('balance-count')).toHaveTextContent('Showing 1 of 4 assets');
  });

  it('shows a no-match notice when the search excludes everything', async () => {
    const user = userEvent.setup();
    render(<AccountBalancesPanel balances={balances} symbols={symbols} quoteAsset="USDT" />);
    await user.type(screen.getByTestId('balance-search'), 'zzz');
    expect(screen.getByText('No assets match.')).toBeInTheDocument();
  });

  it('shows an empty notice when the account holds nothing', () => {
    render(<AccountBalancesPanel balances={[]} symbols={symbols} quoteAsset="USDT" />);
    expect(screen.getByText(/account snapshot is empty/)).toBeInTheDocument();
  });

  it('values priced assets and sums them into the estimated total', () => {
    render(<AccountBalancesPanel balances={balances} symbols={symbols} quoteAsset="USDT" />);
    // BTC: 0.5 × 70000 = 35,000. ETH: 2 locked × 3000 = 6,000. USDT: 1200.25.
    expect(screen.getByTestId('balance-value-BTC')).toHaveTextContent('≈ 35,000.00 USDT');
    expect(screen.getByTestId('balance-value-ETH')).toHaveTextContent('≈ 6,000.00 USDT');
    expect(screen.getByTestId('balance-value-USDT')).toHaveTextContent('≈ 1,200.25 USDT');
    expect(screen.getByTestId('balance-est-value')).toHaveTextContent('≈ 42,200.25 USDT');
  });

  it('keeps a sub-cent BTC quote value visible with the correct asset suffix', () => {
    const btcQuoted = [bal('ETH', '0.009', '0', '0.5')];
    render(<AccountBalancesPanel balances={btcQuoted} symbols={[]} quoteAsset="BTC" />);

    expect(screen.getByTestId('balance-value-ETH')).toHaveTextContent('≈ 0.0045 BTC');
    expect(screen.getByTestId('balance-est-value')).toHaveTextContent('≈ 0.0045 BTC');
  });

  it('leaves an asset unpriced when the profile does not trade its USDT pair', async () => {
    const user = userEvent.setup();
    render(<AccountBalancesPanel balances={balances} symbols={symbols} quoteAsset="USDT" />);
    await user.click(screen.getByLabelText('Hide zero balances'));
    // KZT has no KZTUSDT symbol — no value row.
    expect(screen.queryByTestId('balance-value-KZT')).not.toBeInTheDocument();
  });

  it('sorts by value descending by default, unpriced assets last', async () => {
    const user = userEvent.setup();
    render(<AccountBalancesPanel balances={balances} symbols={symbols} quoteAsset="USDT" />);
    await user.click(screen.getByLabelText('Hide zero balances'));
    const order = screen.getAllByTestId(/^balance-row-/).map((el) => el.dataset.testid);
    // BTC 35k > ETH 6k > USDT 1.2k > KZT (unpriced).
    expect(order).toEqual([
      'balance-row-BTC',
      'balance-row-ETH',
      'balance-row-USDT',
      'balance-row-KZT',
    ]);
  });

  it('sorts alphabetically when the sort select is set to Asset', async () => {
    const user = userEvent.setup();
    render(<AccountBalancesPanel balances={balances} symbols={symbols} quoteAsset="USDT" />);
    await user.selectOptions(screen.getByTestId('balance-sort'), 'asset');
    const order = screen.getAllByTestId(/^balance-row-/).map((el) => el.dataset.testid);
    expect(order).toEqual(['balance-row-BTC', 'balance-row-ETH', 'balance-row-USDT']);
  });

  it('switches to a virtualised scroll container when the visible list exceeds the threshold', () => {
    // 200 asset balances — well above the VIRTUALIZE_THRESHOLD (50) the panel
    // uses to flip from direct render to `useVirtualizer`. The exact threshold
    // and viewport-measurement quirks are not asserted here (happy-dom does
    // not flow ResizeObserver reliably); the regression we lock down is that
    // the panel switches its scroll-container shape so large wallets do not
    // mount every row.
    const big: AssetBalance[] = [];
    for (let i = 0; i < 200; i++) {
      big.push(bal(`ASSET${i.toString().padStart(4, '0')}`, '1'));
    }
    render(<AccountBalancesPanel balances={big} symbols={symbols} />);
    // Virtualised path uses a wrapper div carrying this testid; direct path
    // does not (it puts the testid on the `<ul>`).
    expect(screen.getByTestId('balances-list-scroll')).toBeInTheDocument();
    // Count chip still reads the whole-list size.
    expect(screen.getByTestId('balance-count')).toHaveTextContent('Showing 200 of 200');
    // Regression assertion: the whole point of the virtualisation is to NOT
    // mount every row. happy-dom reports 0×0 viewport so the virtualizer's
    // visible window is small (often 0), but it must never equal the input
    // length — which would mean the panel still mounts every row.
    const rowsInDom = screen.queryAllByTestId(/^balance-row-/).length;
    expect(rowsInDom).toBeLessThan(200);
  });
});

// Binance-style rows show each held asset's icon, name, and quote-asset value; actively traded assets also show the bot's average entry price and unrealized P/L.
type PricedBalance = AssetBalance & { usdPrice: string | null };

const pbal = (
  asset: string,
  free: string,
  usdPrice: string | null,
  locked = '0',
): PricedBalance => ({
  asset,
  free: asDecimalString(free),
  locked: asDecimalString(locked),
  usdPrice: usdPrice == null ? null : asDecimalString(usdPrice),
});

const symPos = (
  symbol: string,
  currentPrice: string,
  avgEntryPrice: string,
  quantity: string,
): DashboardSymbol => ({
  symbol,
  enabled: true,
  avgEntryPrice: asDecimalString(avgEntryPrice),
  currentPrice: asDecimalString(currentPrice),
  quantity: asDecimalString(quantity),
  openOrderCount: 0,
  openOrders: [],
});

describe('AccountBalancesPanel — Binance-style rows (#641)', () => {
  // ETH: priced + actively traded (ETHUSDT held at avg 1600, now 2000).
  // USDT: priced (quote 1:1), no position. DOGE: unpriced, not traded.
  const priced: PricedBalance[] = [
    pbal('ETH', '1.5', '2000'),
    pbal('USDT', '500', '1'),
    pbal('DOGE', '1000', null),
  ];
  const tradedSymbols = [symPos('ETHUSDT', '2000', '1600', '1.5')];

  it('renders a coin icon and the full asset name for a held asset (C1)', () => {
    render(<AccountBalancesPanel balances={priced} symbols={tradedSymbols} quoteAsset="USDT" />);
    expect(screen.getByTestId('coin-icon-ETH')).toBeInTheDocument();
    expect(screen.getByText('Ethereum')).toBeInTheDocument();
  });

  it('shows a quote-asset value for every priced asset and none for an unpriced one (C2/C3)', () => {
    render(<AccountBalancesPanel balances={priced} symbols={tradedSymbols} quoteAsset="USDT" />);
    expect(screen.getByTestId('balance-value-ETH')).toBeInTheDocument();
    expect(screen.getByTestId('balance-value-USDT')).toBeInTheDocument();
    expect(screen.queryByTestId('balance-value-DOGE')).not.toBeInTheDocument();
    // DOGE is a non-zero, unpriced balance — disclosed in the unpriced count.
    expect(screen.getByTestId('balance-unpriced-count')).toHaveTextContent('1');
  });

  it('shows the bot avg-entry price and unrealized PnL only for a traded asset (C4)', () => {
    render(<AccountBalancesPanel balances={priced} symbols={tradedSymbols} quoteAsset="USDT" />);
    const pnl = screen.getByTestId('balance-pnl-ETH');
    // (2000 − 1600) × 1.5 = +600, +25%.
    expect(pnl).toHaveTextContent('+');
    expect(pnl).toHaveTextContent('25');
    // The cell above holds the amount AND the percent, so a substring match on it would pass for `+25%`, `25.00%` or a percent rendered in the wrong tone. The percent carries its own testid, so assert the exact text and the tone on the element that actually renders it.
    const percent = screen.getByTestId('balance-pnl-percent-ETH');
    expect(percent.textContent).toBe('+25.00%');
    expect(percent).toHaveClass('ml-1', 'font-mono', 'text-success');
    // Avg-entry cost basis surfaced on the row.
    expect(screen.getByTestId('balance-row-ETH')).toHaveTextContent('1,600');
  });

  it('renders no PnL element for a priced-but-untraded or unpriced asset (C5)', () => {
    render(<AccountBalancesPanel balances={priced} symbols={tradedSymbols} quoteAsset="USDT" />);
    expect(screen.queryByTestId('balance-pnl-USDT')).not.toBeInTheDocument();
    expect(screen.queryByTestId('balance-pnl-DOGE')).not.toBeInTheDocument();
  });

  it('renders no percent (never a fake -100%) when the held position has no live price (C6)', () => {
    // ETH is held (avg 1600, qty 1.5) but its live price has not arrived yet
    // (currentPrice null). A null price must render blank, never a fake -100%
    // from Number(null) === 0.
    const held: DashboardSymbol = {
      symbol: 'ETHUSDT',
      enabled: true,
      avgEntryPrice: asDecimalString('1600'),
      currentPrice: null,
      quantity: asDecimalString('1.5'),
      openOrderCount: 0,
      openOrders: [],
    };
    render(<AccountBalancesPanel balances={priced} symbols={[held]} quoteAsset="USDT" />);
    const pnl = screen.getByTestId('balance-pnl-ETH');
    expect(pnl).not.toHaveTextContent('%');
    expect(pnl).not.toHaveTextContent('-100');
  });

  it('keeps the wallet balance but drops the cost-basis block for a refused position seed', () => {
    // The coin IS in the wallet, so the balance and its quote value stay — that half must not regress. What goes is the strategy's cost-basis context: the refusal says nothing sellable backs that entry price, so an "Avg 1,600 USDT" line and a P/L computed from it would both assert a position the bot is not running.
    const refused: DashboardSymbol = {
      ...symPos('ETHUSDT', '2000', '1600', '1.5'),
      positionSeedRefusal: { code: 'no-sellable-position', since: '2026-08-27T00:00:00Z' },
    };
    render(<AccountBalancesPanel balances={priced} symbols={[refused]} quoteAsset="USDT" />);

    expect(screen.getByTestId('balance-row-ETH')).toBeInTheDocument();
    expect(screen.getByTestId('balance-value-ETH')).toHaveTextContent('≈ 3,000.00 USDT');
    expect(screen.queryByTestId('balance-pnl-ETH')).not.toBeInTheDocument();
  });
});
