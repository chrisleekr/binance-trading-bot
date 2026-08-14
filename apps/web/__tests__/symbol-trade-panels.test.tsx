// SymbolTradePanels — manual trade form, force-trigger panel, decimal
// validation, confirm-modal gating, and error banners.

import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildManualOrderBody,
  ForceTriggerPanel,
  ManualTradePanel,
  quickFillAmount,
} from '../src/features/symbol/components/symbol-trade-panels.js';
import { createQueryClient } from '../src/shared/lib/query-client.js';

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
  Toaster: () => null,
}));

const PROFILE_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2c';
const SYMBOL = 'BTCUSDT';
const ACTION_ID = '4d2f9f4a-1c9c-4e5f-9a1d-3b6f7c8e0a2d';

const json = (body: unknown, status = 202): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Market fixtures feeding the panel's Avbl readout / quick-select: the account
// holds 0.5 BTC and 1000 USDT, BTCUSDT trades at 50000.
const DASHBOARD_BODY = {
  profileId: PROFILE_ID,
  enabled: true,
  binanceMode: 'test',
  balances: [
    { asset: 'BTC', free: '0.5', locked: '0' },
    { asset: 'USDT', free: '1000', locked: '0' },
  ],
  totalProfit: '0',
  enabledNotifierCount: 0,
  symbols: [],
  cachedAt: '2026-05-17T00:00:00.000Z',
};
const EXCHANGE_INFO_BODY = {
  symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' }],
  fetchedAt: '2026-05-17T00:00:00.000Z',
  technicals: { useOnlyWithinMin: 2, ifExpires: 'do-not-buy' },
};
const TICKER_BODY = {
  symbol: 'BTCUSDT',
  lastPrice: '50000',
  priceChange: '0',
  priceChangePercent: '0',
  highPrice: '50000',
  lowPrice: '50000',
  openPrice: '50000',
  volume: '0',
  quoteVolume: '0',
};

/** Serve the panel's read-only market queries; null = not a market URL. */
const marketResponse = (url: string): Response | null => {
  if (url.includes('/exchange-info')) return json(EXCHANGE_INFO_BODY, 200);
  if (url.includes('/ticker')) return json(TICKER_BODY, 200);
  if (url.includes('/dashboard')) return json(DASHBOARD_BODY, 200);
  return null;
};

const renderManual = (
  responder: (url: string, init?: RequestInit) => Response,
): {
  fetchMock: ReturnType<typeof vi.fn>;
} => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return marketResponse(url) ?? responder(url, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ManualTradePanel profileId={PROFILE_ID} symbol={SYMBOL} />
    </QueryClientProvider>,
  );
  return { fetchMock };
};

const renderForce = (
  responder: (url: string) => Response,
  held?: boolean,
): { fetchMock: ReturnType<typeof vi.fn> } => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url);
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <ForceTriggerPanel profileId={PROFILE_ID} symbol={SYMBOL} held={held} canBuy canSell />
    </QueryClientProvider>,
  );
  return { fetchMock };
};

afterEach(() => {
  vi.unstubAllGlobals();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe('buildManualOrderBody (pure)', () => {
  it('rejects empty amount', () => {
    const out = buildManualOrderBody({
      side: 'BUY',
      type: 'MARKET',
      sizing: 'quoteAmount',
      amount: '',
      price: '',
    });
    expect(out.ok).toBe(false);
  });

  it('requires price for LIMIT', () => {
    const out = buildManualOrderBody({
      side: 'BUY',
      type: 'LIMIT',
      sizing: 'quoteAmount',
      amount: '100',
      price: '',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatch(/price/i);
  });

  it('accepts a valid LIMIT order', () => {
    const out = buildManualOrderBody({
      side: 'SELL',
      type: 'LIMIT',
      sizing: 'quantity',
      amount: '0.01',
      price: '50000',
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.body.side).toBe('SELL');
      expect(out.body.type).toBe('LIMIT');
      expect(out.body.quantity).toBe('0.01');
      expect(out.body.price).toBe('50000');
      expect(out.body.quoteAmount).toBeUndefined();
    }
  });
});

describe('quickFillAmount (pure)', () => {
  it('BUY by quote sizes a fraction of the quote balance', () => {
    expect(quickFillAmount(50, 'BUY', 'quoteAmount', 1000, 0.5, 50000)).toBe('500');
    expect(quickFillAmount(100, 'BUY', 'quoteAmount', 1000, 0.5, 50000)).toBe('1000');
  });

  it('SELL by quantity sizes a fraction of the base balance', () => {
    expect(quickFillAmount(25, 'SELL', 'quantity', 1000, 0.8, 50000)).toBe('0.2');
  });

  it('BUY by quantity converts the quote fraction through the price', () => {
    expect(quickFillAmount(50, 'BUY', 'quantity', 1000, 0.5, 50000)).toBe('0.01');
  });

  it('SELL by quote converts the base fraction through the price', () => {
    expect(quickFillAmount(100, 'SELL', 'quoteAmount', 1000, 0.5, 60000)).toBe('30000');
  });

  it('returns empty when a cross conversion has no price', () => {
    expect(quickFillAmount(50, 'BUY', 'quantity', 1000, 0.5, 0)).toBe('');
    expect(quickFillAmount(50, 'SELL', 'quoteAmount', 1000, 0.5, 0)).toBe('');
  });

  it('trims trailing zeros from a fractional result', () => {
    // 50% of 1.2 quote / price 50 = 0.012 — must format as '0.012', not '0.01200000'.
    expect(quickFillAmount(50, 'BUY', 'quantity', 1.2, 0, 50)).toBe('0.012');
  });
});

describe('ManualTradePanel — interactions', () => {
  it('fills the amount from a percentage of the available balance', async () => {
    renderManual(() => json({ scheduledAt: '', overrideActionId: '' }));
    // Default side BUY, sizing quote → Avbl is the 1000 USDT quote balance.
    await waitFor(() =>
      expect(screen.getByTestId('manual-avbl')).toHaveTextContent('1,000.00 USDT'),
    );
    await userEvent.click(screen.getByTestId('manual-pct-50'));
    expect(screen.getByTestId('manual-amount')).toHaveValue('500');
  });

  it('labels the size-by options as self-describing Cash/Coin rather than raw quote/qty', async () => {
    renderManual(() => json({ scheduledAt: '', overrideActionId: '' }));
    await screen.findByTestId('manual-sizing');
    expect(screen.getByRole('option', { name: 'Cash (quote)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Coin (quantity)' })).toBeInTheDocument();
  });

  it('disables the percentage buttons when the account holds no balance', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/exchange-info')) return json(EXCHANGE_INFO_BODY, 200);
      if (url.includes('/ticker')) return json(TICKER_BODY, 200);
      // Account holds nothing — every quick-fill resolves to an empty amount.
      if (url.includes('/dashboard')) {
        return json({ ...DASHBOARD_BODY, balances: [] }, 200);
      }
      return json({ scheduledAt: '', overrideActionId: '' });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ManualTradePanel profileId={PROFILE_ID} symbol={SYMBOL} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('manual-avbl')).toHaveTextContent('0 USDT'));
    expect(screen.getByTestId('manual-pct-50')).toBeDisabled();
  });

  it('warns when the amount exceeds the available balance', async () => {
    renderManual(() => json({ scheduledAt: '', overrideActionId: '' }));
    await waitFor(() =>
      expect(screen.getByTestId('manual-avbl')).toHaveTextContent('1,000.00 USDT'),
    );

    // Empty amount — no warning.
    expect(screen.queryByTestId('manual-insufficient')).not.toBeInTheDocument();

    // Within the 1000 USDT quote balance — still no warning.
    await userEvent.type(screen.getByTestId('manual-amount'), '500');
    expect(screen.queryByTestId('manual-insufficient')).not.toBeInTheDocument();

    // Above it — the inline warning names the quote asset.
    await userEvent.clear(screen.getByTestId('manual-amount'));
    await userEvent.type(screen.getByTestId('manual-amount'), '2000');
    expect(screen.getByTestId('manual-insufficient')).toHaveTextContent(/exceeds available USDT/i);

    // A SELL sizes against the base balance (0.5 BTC) instead.
    await userEvent.selectOptions(screen.getByTestId('manual-side'), 'SELL');
    await userEvent.selectOptions(screen.getByTestId('manual-sizing'), 'quantity');
    await userEvent.clear(screen.getByTestId('manual-amount'));
    await userEvent.type(screen.getByTestId('manual-amount'), '1');
    expect(screen.getByTestId('manual-insufficient')).toHaveTextContent(/exceeds available BTC/i);
  });

  it('opens the confirm modal then POSTs the order on confirm', async () => {
    const { fetchMock } = renderManual((url) => {
      if (url.includes('/manual-order')) {
        return json({
          scheduledAt: '2026-05-10T12:00:00.000Z',
          overrideActionId: ACTION_ID,
          createdAt: '2026-05-10T12:00:00.000Z',
        });
      }
      throw new Error(`unexpected ${url}`);
    });

    await userEvent.type(screen.getByTestId('manual-amount'), '100');
    await userEvent.click(screen.getByTestId('manual-review'));

    await waitFor(() => expect(screen.getByText(/Confirm manual order/)).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('manual-confirm'));

    // The 202 is not the outcome, only the schedule — the toast says so and the
    // panel then polls for what actually happened.
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Scheduled/)),
    );

    const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/manual-order'));
    expect(call).toBeTruthy();
    const init = call?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.side).toBe('BUY');
    expect(body.type).toBe('MARKET');
    expect(body.quoteAmount).toBe('100');
  });

  it('recaps Price, Amount and Total in the confirm modal for a MARKET order', async () => {
    renderManual(() => json({ scheduledAt: '', overrideActionId: '' }));
    await waitFor(() =>
      expect(screen.getByTestId('manual-avbl')).toHaveTextContent('1,000.00 USDT'),
    );
    await userEvent.type(screen.getByTestId('manual-amount'), '100');
    await userEvent.click(screen.getByTestId('manual-review'));
    await screen.findByTestId('manual-order-recap');
    // MARKET → price is the live last (50000, estimated); quote-sized → Total
    // is exact (the input), Amount is derived 100 / 50000 = 0.002 BTC.
    expect(screen.getByTestId('recap-price')).toHaveTextContent('≈ 50,000 USDT');
    expect(screen.getByTestId('recap-amount')).toHaveTextContent('≈ 0.002 BTC');
    expect(screen.getByTestId('recap-total')).toHaveTextContent('100 USDT');
  });

  it('recaps an exact price and a derived total for a LIMIT order sized by quantity', async () => {
    renderManual(() => json({ scheduledAt: '', overrideActionId: '' }));
    await userEvent.selectOptions(screen.getByTestId('manual-type'), 'LIMIT');
    await userEvent.selectOptions(screen.getByTestId('manual-sizing'), 'quantity');
    await userEvent.type(screen.getByTestId('manual-amount'), '0.5');
    await userEvent.type(screen.getByTestId('manual-price'), '80000');
    await userEvent.click(screen.getByTestId('manual-review'));
    await screen.findByTestId('manual-order-recap');
    // LIMIT → exact price, no ≈; qty-sized → Amount exact, Total derived
    // 0.5 * 80000 = 40000.
    expect(screen.getByTestId('recap-price')).toHaveTextContent('80,000 USDT');
    expect(screen.getByTestId('recap-price')).not.toHaveTextContent('≈');
    expect(screen.getByTestId('recap-amount')).toHaveTextContent('0.5 BTC');
    expect(screen.getByTestId('recap-total')).toHaveTextContent('≈ 40,000 USDT');
  });

  it('recap degrades to a notice when the live price is unavailable for a MARKET order', async () => {
    // Ticker 502s → no live last price → the MARKET recap cannot estimate.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/exchange-info')) return json(EXCHANGE_INFO_BODY, 200);
      if (url.includes('/ticker')) return json({ error: { code: 'UPSTREAM_FAILED' } }, 502);
      if (url.includes('/dashboard')) return json(DASHBOARD_BODY, 200);
      return json({ scheduledAt: '', overrideActionId: '' });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ManualTradePanel profileId={PROFILE_ID} symbol={SYMBOL} />
      </QueryClientProvider>,
    );
    await userEvent.type(screen.getByTestId('manual-amount'), '100');
    await userEvent.click(screen.getByTestId('manual-review'));
    await screen.findByTestId('manual-order-recap');
    expect(screen.getByTestId('recap-price')).toHaveTextContent('—');
    expect(screen.getByTestId('recap-amount')).toHaveTextContent('—');
    // Total is the exact quote input, unaffected by the missing price.
    expect(screen.getByTestId('recap-total')).toHaveTextContent('100 USDT');
    expect(screen.getByText(/Live price unavailable/)).toBeInTheDocument();
  });

  it('shows an error banner when the amount is empty', async () => {
    renderManual(() => json({ scheduledAt: '', overrideActionId: '' }));
    await userEvent.click(screen.getByTestId('manual-review'));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/Amount is required/)),
    );
  });

  it('shows the price field only when type is LIMIT', async () => {
    renderManual(() => json({ scheduledAt: '', overrideActionId: '' }));
    expect(screen.queryByTestId('manual-price')).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByTestId('manual-type'), 'LIMIT');
    expect(screen.getByTestId('manual-price')).toBeInTheDocument();
  });

  it('surfaces server error message in the banner', async () => {
    renderManual(
      () =>
        new Response(
          JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: 'bad amount' } }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        ),
    );
    await userEvent.type(screen.getByTestId('manual-amount'), '100');
    await userEvent.click(screen.getByTestId('manual-review'));
    await waitFor(() => expect(screen.getByText(/Confirm manual order/)).toBeInTheDocument());
    await userEvent.click(screen.getByTestId('manual-confirm'));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/bad amount/)),
    );
  });
});

describe('ForceTriggerPanel — interactions', () => {
  it('Force buy modal calls /trigger-buy and surfaces the schedule', async () => {
    const { fetchMock } = renderForce((url) => {
      if (url.includes('/trigger-buy')) {
        return json({
          scheduledAt: '2026-05-10T12:00:00.000Z',
          overrideActionId: ACTION_ID,
          createdAt: '2026-05-10T12:00:00.000Z',
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    await userEvent.click(screen.getByTestId('force-buy'));
    await waitFor(() =>
      expect(screen.getByText(/regardless of the Technicals gate/)).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByTestId('force-confirm'));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Force buy scheduled/)),
    );

    const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/trigger-buy'));
    expect(call).toBeTruthy();
  });

  it('replaces the optimistic "scheduled" message with the settled outcome', async () => {
    // A 202 only means "recorded". Telling the operator "Force sell scheduled"
    // and never correcting it is exactly how a sell that Binance REFUSED reads
    // as a success. The panel polls the override row and reports what happened.
    renderForce((url) => {
      if (url.includes('/trigger-sell')) {
        return json({
          scheduledAt: '2026-05-10T12:00:00.000Z',
          overrideActionId: ACTION_ID,
          createdAt: '2026-05-10T12:00:00.000Z',
        });
      }
      if (url.includes('/override')) {
        return json(
          {
            id: ACTION_ID,
            symbol: SYMBOL,
            action: 'sell',
            actionAt: '2026-05-10T12:00:00.000Z',
            payload: {},
            triggeredBy: 'user',
            processingAt: null,
            consumedAt: '2026-05-10T12:00:03.000Z',
            outcome: {
              status: 'rejected',
              reason: 'binance logic -2010: insufficient balance',
              at: '2026-05-10T12:00:03.000Z',
            },
            createdAt: '2026-05-10T12:00:00.000Z',
          },
          200,
        );
      }
      throw new Error(`unexpected ${url}`);
    });

    await userEvent.click(screen.getByTestId('force-sell'));
    await userEvent.click(screen.getByTestId('force-confirm'));

    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Force sell scheduled/)),
    );
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/did not run: .*-2010/)),
    );
  });

  it('back-to-back confirm clicks fire only one POST', async () => {
    let resolver: (v: Response) => void = () => undefined;
    const slow = new Promise<Response>((r) => {
      resolver = r;
    });
    const { fetchMock } = renderForce(() => {
      // Returning the same promise twice keeps the second invocation pending,
      // which is what would happen if a second mutate slipped through. We
      // assert that fetch is called exactly once.
      return slow as unknown as Response;
    });
    await userEvent.click(screen.getByTestId('force-buy'));
    await waitFor(() =>
      expect(screen.getByText(/regardless of the Technicals gate/)).toBeInTheDocument(),
    );
    const confirm = screen.getByTestId('force-confirm');
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes('/trigger-buy')),
    ).toHaveLength(1);
    await act(async () => {
      resolver(
        json({
          scheduledAt: '2026-05-10T12:00:00.000Z',
          overrideActionId: ACTION_ID,
          createdAt: '2026-05-10T12:00:00.000Z',
        }),
      );
    });
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Force buy scheduled/)),
    );
  });

  it('Force sell modal calls /trigger-sell', async () => {
    const { fetchMock } = renderForce((url) => {
      if (url.includes('/trigger-sell')) {
        return json({
          scheduledAt: '2026-05-10T12:00:00.000Z',
          overrideActionId: ACTION_ID,
          createdAt: '2026-05-10T12:00:00.000Z',
        });
      }
      throw new Error(`unexpected ${url}`);
    });
    await userEvent.click(screen.getByTestId('force-sell'));
    await waitFor(() => expect(screen.getByText(/a notification is sent/)).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('force-confirm'));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/Force sell scheduled/)),
    );

    const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/trigger-sell'));
    expect(call).toBeTruthy();
  });

  it('disables Force sell on a confirmed flat symbol and explains why', async () => {
    renderForce(() => {
      throw new Error('no request should fire on a flat symbol');
    }, false);
    const sell = screen.getByTestId('force-sell');
    expect(sell).toBeDisabled();
    expect(screen.getByTestId('force-sell-flat-note')).toBeInTheDocument();
    // Clicking a disabled button must not open the confirm dialog.
    await userEvent.click(sell);
    expect(screen.queryByTestId('force-confirm')).not.toBeInTheDocument();
  });

  it('keeps Force sell enabled while the position read is loading (fail-open)', () => {
    renderForce(() => json({}), undefined);
    expect(screen.getByTestId('force-sell')).toBeEnabled();
    expect(screen.queryByTestId('force-sell-flat-note')).not.toBeInTheDocument();
  });

  it('warns that Force buy adds to an existing position when already held', async () => {
    renderForce(() => json({}), true);
    expect(screen.getByTestId('force-sell')).toBeEnabled();
    await userEvent.click(screen.getByTestId('force-buy'));
    await waitFor(() => expect(screen.getByText(/already hold a position/i)).toBeInTheDocument());
  });
});
