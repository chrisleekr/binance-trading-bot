import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import type { BinanceRestClient } from '@app/binance';

const repoMocks = vi.hoisted(() => ({
  listWithUnvaluedFees: vi.fn(),
  updateFees: vi.fn(async () => true),
  profileRepo: vi.fn(),
}));

vi.mock('@app/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@app/db')>();
  return { ...orig, profileRepo: repoMocks.profileRepo };
});

const { handleReconcileFees } =
  await import('../../src/queues/pipeline-handlers/reconcile-fees.js');

const logWarn = vi.fn();
const logger = { warn: logWarn, info: vi.fn() } as unknown as Logger;
const warnEvents = (): string[] => logWarn.mock.calls.map((c) => c[1] as string);
const IDS = { userId: 'u1' as never, accountId: 'a1' as never, profileId: 'p1' as never };

/** A per-symbol commission payload in Binance's own shape: 0.1% on the taker and seller legs, 25% off when the fee is charged in BNB. */
const commissionPayload = (discountAsset: string) => ({
  symbol: 'BTCUSDT',
  standardCommission: { maker: '0', taker: '0.001', buyer: '0', seller: '0' },
  taxCommission: { maker: '0', taker: '0', buyer: '0', seller: '0' },
  specialCommission: { maker: '0', taker: '0', buyer: '0', seller: '0' },
  discount: {
    enabledForAccount: true,
    enabledForSymbol: true,
    discountAsset,
    discount: '0.75',
  },
});

const fakeClient = (
  trades: unknown[],
  commissionRates?: () => Promise<unknown>,
): BinanceRestClient =>
  ({
    getMyTrades: vi.fn(async () => trades),
    getCommissionRates: vi.fn(commissionRates ?? (async () => commissionPayload('USDT'))),
  }) as unknown as BinanceRestClient;

const myTrade = (
  orderId: number,
  commission: string,
  commissionAsset: string,
  price = '100',
  isBuyer = false,
  overrides: Partial<{ id: number; qty: string; quoteQty: string }> = {},
) =>
  ({
    id: overrides.id ?? orderId * 10,
    orderId,
    symbol: 'BTCUSDT',
    commission,
    commissionAsset,
    price,
    qty: overrides.qty ?? '1',
    quoteQty: overrides.quoteQty ?? '100',
    time: 0,
    isBuyer,
    isMaker: false,
  }) as never;

const feeOrder = (
  orderId: number,
  overrides: Partial<{
    side: 'BUY' | 'SELL';
    executedQty: string;
    cummulativeQuoteQty: string;
    baseCommissionNetted: string | null;
  }> = {},
) => ({
  binanceOrderId: String(orderId),
  side: 'SELL' as const,
  executedQty: '1',
  cummulativeQuoteQty: '100',
  baseCommissionNetted: null,
  ...overrides,
});

const row = (orders: unknown[]) => ({
  id: 'a1',
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  orders,
});

const deps = (client: BinanceRestClient | null) => ({
  db: {} as never,
  logger,
  resolveBinanceClient: vi.fn(async () => client),
});

beforeEach(() => {
  logWarn.mockClear();
  repoMocks.listWithUnvaluedFees.mockReset();
  repoMocks.updateFees.mockClear().mockResolvedValue(true);
  repoMocks.profileRepo.mockResolvedValue({
    tradeArchive: {
      listWithUnvaluedFees: repoMocks.listWithUnvaluedFees,
      updateFees: repoMocks.updateFees,
    },
  });
});

describe('handleReconcileFees', () => {
  it('does nothing when there are no unvalued rows', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([]);
    await handleReconcileFees(deps(fakeClient([])), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
  });

  it('returns without updating when the Binance client is unavailable', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([feeOrder(101)])]);
    await handleReconcileFees(deps(null), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
  });

  it('backfills matched commission into the archive row', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([feeOrder(101)])]);
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.5', 'USDT')])), IDS);
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { USDT: '0.5' }, '0.5', 'exact');
  });

  it('leaves a row untouched when no recent trade matches its orders (too old)', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([feeOrder(999)])]);
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.5', 'USDT')])), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
  });

  it('skips a row whose orders carry no Binance order id', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([])]);
    await handleReconcileFees(deps(fakeClient([])), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
  });

  it('warns on a partial match without replacing the stored fee evidence', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([feeOrder(101), feeOrder(102)])]);
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.5', 'USDT')])), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
    expect(warnEvents()).toContain('pipeline_reconcile_fees_partial');
  });

  it('values a base-asset commission at the fill price', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([feeOrder(101)])]);
    // 0.001 BTC commission at price 60000 → 60 USDT.
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.001', 'BTC', '60000')])), IDS);
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { BTC: '0.001' }, '60', 'exact');
  });

  it('marks a fully matched base-asset BUY zero adjustment complete with cost-basis proof', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([
      row([feeOrder(101, { side: 'BUY', baseCommissionNetted: '0.001' })]),
    ]);
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.001', 'BTC', '60000', true)])), IDS);
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { BTC: '0.001' }, '0', 'exact');
  });

  it('keeps a base-asset BUY incomplete when the archived order lacks cost-basis proof', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([feeOrder(101, { side: 'BUY' })])]);
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.001', 'BTC', '60000', true)])), IDS);
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { BTC: '0.001' }, '0', 'unknown');
  });

  it('does not trust a proof-like field inside archived Binance raw JSON', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([
      row([
        {
          ...feeOrder(101, { side: 'BUY' }),
          raw: { baseCommissionNetted: '0.001' },
        },
      ]),
    ]);
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.001', 'BTC', '60000', true)])), IDS);
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { BTC: '0.001' }, '0', 'unknown');
  });

  it('keeps a partial multi-fill order incomplete even when its order id matched', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([
      row([feeOrder(101, { executedQty: '2', cummulativeQuoteQty: '200' })]),
    ]);
    await handleReconcileFees(deps(fakeClient([myTrade(101, '0.1', 'USDT')])), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
    expect(warnEvents()).toContain('pipeline_reconcile_fees_order_evidence_incomplete');
  });

  it('keeps an unpriceable commission in fees but out of feesQuote, and warns', async () => {
    // Unchanged behaviour, reached through the one remaining route to it: the per-symbol rate lookup failed, so nothing can say what Binance charged. The fee evidence is still preserved and the adjustment still declines to claim a number.
    const client = {
      getMyTrades: vi.fn(async () => [myTrade(101, '0.01', 'DOGE')]),
      getCommissionRates: vi.fn(async () => {
        throw new Error('-1121 Invalid symbol');
      }),
      getTicker24hr: vi.fn(async () => ({ lastPrice: '0.2' })),
    } as unknown as BinanceRestClient;
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([feeOrder(101)])]);
    await handleReconcileFees(deps(client), IDS);
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { DOGE: '0.01' }, '0', 'unknown');
    expect(warnEvents()).toContain('pipeline_reconcile_fees_unpriced');
    // No ticker substitution anywhere on the failure path. Today's price would value a months-old fill at this moment's market and certify the row on a number nobody can reconstruct.
    expect(client.getTicker24hr).not.toHaveBeenCalled();
  });

  it('values a third-asset commission from the rates Binance charged and marks the row estimated', async () => {
    // The commission was charged in DOGE, which is neither base nor quote, so `myTrades` carries no rate for it. `GET /api/v3/account/commission` does: 0.1% taker+seller on a 100-quote fill, discounted to 75% because the charge landed in the discount asset.
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([feeOrder(101)])]);
    await handleReconcileFees(
      deps(fakeClient([myTrade(101, '0.01', 'DOGE')], async () => commissionPayload('DOGE'))),
      IDS,
    );
    // Reconcile reads the rate table at today's clock for a fill of unknown age, so the reconstruction it produces is usable but not the charge Binance reported. The middle tier is what says so; certifying it here would put a reconstructed number under an unmarked profit factor.
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { DOGE: '0.01' }, '0.075', 'estimated');
    expect(warnEvents()).not.toContain('pipeline_reconcile_fees_unpriced');
  });

  it('asks for commission rates once per symbol across a multi-row pass', async () => {
    // Weight 20 a call, on a pass that walks up to 500 rows. The rates cannot change inside one job, so one resolver is built before the loop and every row on the symbol reads its memo.
    repoMocks.listWithUnvaluedFees.mockResolvedValue([
      { ...row([feeOrder(101)]), id: 'a1' },
      { ...row([feeOrder(102)]), id: 'a2' },
    ]);
    const client = fakeClient(
      [myTrade(101, '0.01', 'DOGE'), myTrade(102, '0.02', 'DOGE')],
      async () => commissionPayload('DOGE'),
    );
    await handleReconcileFees(deps(client), IDS);
    expect(client.getCommissionRates).toHaveBeenCalledTimes(1);
    expect(repoMocks.updateFees).toHaveBeenCalledTimes(2);
  });

  it('does not spend a commission-rates call on a pass whose fees all priced themselves', async () => {
    // The lazy half. A quote-asset commission carries its own valuation, so the ordinary cycle must add no weight at all.
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([feeOrder(101)])]);
    const client = fakeClient([myTrade(101, '0.5', 'USDT')]);
    await handleReconcileFees(deps(client), IDS);
    expect(client.getCommissionRates).not.toHaveBeenCalled();
    expect(repoMocks.updateFees).toHaveBeenCalledWith('a1', { USDT: '0.5' }, '0.5', 'exact');
  });

  it('warns and skips a row when its symbol trade fetch fails', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([row([feeOrder(101)])]);
    const client = {
      getMyTrades: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    } as unknown as BinanceRestClient;
    await handleReconcileFees(deps(client), IDS);
    expect(repoMocks.updateFees).not.toHaveBeenCalled();
    expect(warnEvents()).toContain('pipeline_reconcile_fees_fetch_failed');
  });

  it('fetches myTrades once per symbol across rows (cache hit)', async () => {
    repoMocks.listWithUnvaluedFees.mockResolvedValue([
      { ...row([feeOrder(101)]), id: 'a1' },
      { ...row([feeOrder(102)]), id: 'a2' },
    ]);
    const client = fakeClient([myTrade(101, '0.5', 'USDT'), myTrade(102, '0.7', 'USDT')]);
    await handleReconcileFees(deps(client), IDS);
    expect(client.getMyTrades).toHaveBeenCalledTimes(1);
    expect(repoMocks.updateFees).toHaveBeenCalledTimes(2);
  });
});
