import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '@app/money';
import type { MyTradeDto } from '@app/binance';
import {
  resolveFees,
  type ArchiveGridTradeHandlerDeps,
  type ArchiveGridTradeJobPayload,
} from '../../src/queues/pipeline-handlers/archive-grid-trade.js';

const myTrade = (o: {
  orderId: number;
  commission: string;
  commissionAsset: string;
  id?: number;
  symbol?: string;
  price?: string;
  qty?: string;
  quoteQty?: string;
  isBuyer?: boolean;
}): MyTradeDto =>
  ({
    id: o.id ?? o.orderId * 10,
    orderId: o.orderId,
    symbol: o.symbol ?? 'BTCUSDT',
    price: o.price ?? '100',
    qty: o.qty ?? '1',
    quoteQty: o.quoteQty ?? '100',
    commission: o.commission,
    commissionAsset: o.commissionAsset,
    time: 0,
    isBuyer: o.isBuyer ?? false,
    isMaker: false,
  }) as MyTradeDto;

const expectedOrder = (
  orderId: number,
  overrides: Partial<{
    side: 'BUY' | 'SELL' | null;
    executedQty: string | null;
    cummulativeQuoteQty: string | null;
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

/** Deps stub exposing only the logger + client `resolveFees` actually reads. */
function depsFor(trades: readonly MyTradeDto[] | Error): {
  deps: ArchiveGridTradeHandlerDeps;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const client = {
    getMyTrades: vi.fn(async () => {
      if (trades instanceof Error) throw trades;
      return trades;
    }),
  };
  const deps = {
    logger: { warn },
    resolveBinanceClient: vi.fn(async () => client),
  } as unknown as ArchiveGridTradeHandlerDeps;
  return { deps, warn };
}

const PAYLOAD = {
  userId: 'u1',
  profileId: 'p1',
  symbol: 'BTCUSDT',
} as unknown as ArchiveGridTradeJobPayload;

// The tier under test here is the EVIDENCE rule alone: none of these cases reaches the rate table, so each one resolves to `exact` or `unknown`. The `estimated` tier belongs to the reconstruction arm and is pinned in `archive-grid-trade.test.ts`.
describe('resolveFees', () => {
  it('preserves a third-asset commission without valuing it at a current ticker', async () => {
    const { deps, warn } = depsFor([
      myTrade({ orderId: 1, commission: '0.1', commissionAsset: 'USDT' }),
      myTrade({ orderId: 2, commission: '0.2', commissionAsset: 'BNB' }),
    ]);
    const out = await resolveFees(
      deps,
      PAYLOAD,
      [expectedOrder(1), expectedOrder(2)],
      'BTC',
      'USDT',
    );
    // BNB stays in the raw audit map but is left OUT of the quote total.
    expect(out).toMatchObject({
      fees: { USDT: '0.1', BNB: '0.2' },
      feesQuote: '0.1',
      feeBasis: 'unknown',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ unpricedTrades: 1 }),
      'pipeline_archive_grid_trade_fees_quote_unpriced',
    );
  });

  it('returns empty when there are no archived orders', async () => {
    const { deps } = depsFor([]);
    const out = await resolveFees(deps, PAYLOAD, [], 'BTC', 'USDT');
    expect(out).toEqual({ fees: {}, feesQuote: '0', feeBasis: 'unknown' });
  });

  it('marks a fully matched base-asset BUY zero adjustment complete with cost-basis proof', async () => {
    const { deps } = depsFor([
      myTrade({
        orderId: 1,
        commission: '0.01',
        commissionAsset: 'BTC',
        price: '60000',
        isBuyer: true,
      }),
    ]);
    const out = await resolveFees(
      deps,
      PAYLOAD,
      [expectedOrder(1, { side: 'BUY', baseCommissionNetted: '0.01' })],
      'BTC',
      'USDT',
    );
    expect(out).toEqual({
      fees: { BTC: '0.01' },
      feesQuote: '0',
      feeBasis: 'exact',
    });
  });

  it('does not certify a base-asset BUY zero without cost-basis proof', async () => {
    const { deps } = depsFor([
      myTrade({
        orderId: 1,
        commission: '0.01',
        commissionAsset: 'BTC',
        price: '60000',
        isBuyer: true,
      }),
    ]);
    const out = await resolveFees(
      deps,
      PAYLOAD,
      [expectedOrder(1, { side: 'BUY' })],
      'BTC',
      'USDT',
    );
    expect(out).toEqual({
      fees: { BTC: '0.01' },
      feesQuote: '0',
      feeBasis: 'unknown',
    });
  });

  it('does not certify a partial base-fee amount as the whole netted commission', async () => {
    const { deps } = depsFor([
      myTrade({
        orderId: 1,
        commission: '0.01',
        commissionAsset: 'BTC',
        price: '60000',
        isBuyer: true,
      }),
    ]);
    const out = await resolveFees(
      deps,
      PAYLOAD,
      [expectedOrder(1, { side: 'BUY', baseCommissionNetted: '0.004' })],
      'BTC',
      'USDT',
    );
    expect(out).toEqual({ fees: { BTC: '0.01' }, feesQuote: '0', feeBasis: 'unknown' });
  });

  it('values a fully matched base-asset SELL commission at the fill price', async () => {
    const { deps } = depsFor([
      myTrade({ orderId: 1, commission: '0.01', commissionAsset: 'BTC', price: '60000' }),
    ]);
    const out = await resolveFees(deps, PAYLOAD, [expectedOrder(1)], 'BTC', 'USDT');
    expect(out).toEqual({ fees: { BTC: '0.01' }, feesQuote: '600', feeBasis: 'exact' });
  });

  it('does not certify one returned fill as the whole multi-fill order', async () => {
    const { deps } = depsFor([
      myTrade({
        orderId: 1,
        id: 10,
        qty: '1',
        quoteQty: '100',
        commission: '0.1',
        commissionAsset: 'USDT',
      }),
    ]);
    const out = await resolveFees(
      deps,
      PAYLOAD,
      [expectedOrder(1, { executedQty: '2', cummulativeQuoteQty: '200' })],
      'BTC',
      'USDT',
    );
    expect(out).toMatchObject({
      fees: { USDT: '0.1' },
      feesQuote: '0.1',
      feeBasis: 'unknown',
    });
  });

  it('rejects a matching order id returned for another symbol', async () => {
    const { deps } = depsFor([
      myTrade({
        orderId: 1,
        symbol: 'ETHUSDT',
        commission: '0.1',
        commissionAsset: 'USDT',
      }),
    ]);
    const out = await resolveFees(deps, PAYLOAD, [expectedOrder(1)], 'BTC', 'USDT');
    expect(out).toEqual({ fees: {}, feesQuote: '0', feeBasis: 'unknown' });
  });

  it('marks a missing archived order incomplete', async () => {
    const { deps } = depsFor([myTrade({ orderId: 1, commission: '0.1', commissionAsset: 'USDT' })]);
    const out = await resolveFees(
      deps,
      PAYLOAD,
      [expectedOrder(1), expectedOrder(2)],
      'BTC',
      'USDT',
    );
    expect(out).toMatchObject({ feesQuote: '0.1', feeBasis: 'unknown' });
  });

  it('marks a failed trade fetch incomplete', async () => {
    const { deps } = depsFor(new Error('rate limited'));
    const out = await resolveFees(deps, PAYLOAD, [expectedOrder(1)], 'BTC', 'USDT');
    expect(out).toEqual({ fees: {}, feesQuote: '0', feeBasis: 'unknown' });
  });

  it('marks an unparseable commission incomplete', async () => {
    const { deps } = depsFor([
      myTrade({ orderId: 1, commission: 'not-a-decimal', commissionAsset: 'USDT' }),
    ]);
    const out = await resolveFees(deps, PAYLOAD, [expectedOrder(1)], 'BTC', 'USDT');
    expect(out).toEqual({ fees: {}, feesQuote: '0', feeBasis: 'unknown' });
  });

  it('preserves a valid reported commission when another fill field is malformed', async () => {
    const { deps } = depsFor([
      myTrade({
        orderId: 1,
        qty: 'not-a-decimal',
        commission: '0.1',
        commissionAsset: 'USDT',
      }),
    ]);
    const out = await resolveFees(deps, PAYLOAD, [expectedOrder(1)], 'BTC', 'USDT');
    expect(out).toEqual({ fees: { USDT: '0.1' }, feesQuote: '0.1', feeBasis: 'unknown' });
  });

  describe('fee basis', () => {
    it("declares 'exact' when every commission is valued and every expected order matched", async () => {
      const { deps } = depsFor([
        myTrade({ orderId: 1, commission: '0.01', commissionAsset: 'BTC', price: '60000' }),
      ]);
      const out = await resolveFees(deps, PAYLOAD, [expectedOrder(1)], 'BTC', 'USDT');
      expect(out).toMatchObject({ feesQuote: '600', feeBasis: 'exact' });
    });

    it("declares 'unknown', never 'exact', for an order the trade history never returned", async () => {
      const { deps } = depsFor([
        myTrade({ orderId: 1, commission: '0.1', commissionAsset: 'USDT' }),
      ]);
      const out = await resolveFees(
        deps,
        PAYLOAD,
        [expectedOrder(1), expectedOrder(2)],
        'BTC',
        'USDT',
      );
      expect(out.feeBasis).toBe('unknown');
    });

    it("declares 'unknown' for a commission in an asset nothing here can price", async () => {
      const { deps } = depsFor([
        myTrade({ orderId: 1, commission: '0.1', commissionAsset: 'USDT' }),
        myTrade({ orderId: 2, commission: '0.2', commissionAsset: 'BNB' }),
      ]);
      const out = await resolveFees(
        deps,
        PAYLOAD,
        [expectedOrder(1), expectedOrder(2)],
        'BTC',
        'USDT',
      );
      expect(out.feeBasis).toBe('unknown');
    });

    it("declares 'unknown' when a returned fill cannot account for the whole order", async () => {
      const { deps } = depsFor([
        myTrade({
          orderId: 1,
          id: 10,
          qty: '1',
          quoteQty: '100',
          commission: '0.1',
          commissionAsset: 'USDT',
        }),
      ]);
      const out = await resolveFees(
        deps,
        PAYLOAD,
        [expectedOrder(1, { executedQty: '2', cummulativeQuoteQty: '200' })],
        'BTC',
        'USDT',
      );
      expect(out.feeBasis).toBe('unknown');
    });

    it("declares 'unknown' for a commission that does not parse as a decimal", async () => {
      const { deps } = depsFor([
        myTrade({ orderId: 1, commission: 'not-a-decimal', commissionAsset: 'USDT' }),
      ]);
      const out = await resolveFees(deps, PAYLOAD, [expectedOrder(1)], 'BTC', 'USDT');
      expect(out.feeBasis).toBe('unknown');
    });

    it("declares 'unknown' for a base-asset BUY with no cost-basis proof", async () => {
      // The zero adjustment is right only if the cost basis already absorbed the fee. Without the netted amount on the order there is nothing saying it did, and a zero that means "we did not check" must not read as a zero that means "there was nothing to charge".
      const { deps } = depsFor([
        myTrade({
          orderId: 1,
          commission: '0.01',
          commissionAsset: 'BTC',
          price: '60000',
          isBuyer: true,
        }),
      ]);
      const out = await resolveFees(
        deps,
        PAYLOAD,
        [expectedOrder(1, { side: 'BUY' })],
        'BTC',
        'USDT',
      );
      expect(out.feeBasis).toBe('unknown');
    });

    it("declares 'unknown' when the trade fetch failed outright", async () => {
      const { deps } = depsFor(new Error('rate limited'));
      const out = await resolveFees(deps, PAYLOAD, [expectedOrder(1)], 'BTC', 'USDT');
      expect(out.feeBasis).toBe('unknown');
    });
  });

  it('nets a base-asset-fee cycle to sellProceeds − sellFee − buyQuotePaid', async () => {
    // The live TSTUSDT cycle: BUY 1682.30 TST for 25.184031 USDT with a 1.6823
    // TST fee, protective SELL for 31.292772 USDT with a 0.03129277 USDT fee.
    // The BUY fee is coins the wallet never received, so the cost basis already
    // carries it; only the SELL fee is cash the operator paid on top.
    const BUY_QUOTE_PAID = new Decimal('25.184031');
    const SELL_PROCEEDS = new Decimal('31.292772');
    const SELL_FEE = new Decimal('0.03129277');
    const { deps } = depsFor([
      myTrade({
        orderId: 1,
        commission: '1.6823',
        commissionAsset: 'TST',
        price: '0.014970',
        isBuyer: true,
      }),
      myTrade({
        orderId: 2,
        commission: SELL_FEE.toString(),
        commissionAsset: 'USDT',
        price: '0.018620',
      }),
    ]);
    const out = await resolveFees(
      deps,
      PAYLOAD,
      [expectedOrder(1, { side: 'BUY', baseCommissionNetted: '1.6823' }), expectedOrder(2)],
      'TST',
      'USDT',
    );

    // Both commissions stay in the raw audit map; only the quote total changes.
    expect(out.fees).toEqual({ TST: '1.6823', USDT: '0.03129277' });
    expect(out.feesQuote).toBe(SELL_FEE.toString());

    // The identity the API's `netProfit = profit − feesQuote` has to satisfy.
    const profit = SELL_PROCEEDS.minus(BUY_QUOTE_PAID);
    const netProfit = profit.minus(new Decimal(out.feesQuote));
    expect(netProfit.toString()).toBe(
      SELL_PROCEEDS.minus(SELL_FEE).minus(BUY_QUOTE_PAID).toString(),
    );
  });
});
