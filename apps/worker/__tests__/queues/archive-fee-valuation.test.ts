import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '@app/money';
import type { BinanceRestClient } from '@app/binance';

import type { MyTradeDto } from '@app/binance';
import {
  resolveFees,
  valueCommissionInQuote,
  type ArchiveGridTradeHandlerDeps,
  type ArchiveGridTradeJobPayload,
} from '../../src/queues/pipeline-handlers/archive-grid-trade.js';

/** Minimal fake client exposing only the `getTicker24hr` the valuation uses. */
function fakeClient(ticker?: { lastPrice: string } | Error): BinanceRestClient {
  return {
    getTicker24hr: vi.fn(async () => {
      if (ticker instanceof Error) throw ticker;
      if (!ticker) throw new Error('no ticker');
      return ticker as never;
    }),
  } as unknown as BinanceRestClient;
}

const trade = (commission: string, commissionAsset: string, price = '100', isBuyer = false) => ({
  commission,
  commissionAsset,
  price,
  isBuyer,
});

describe('valueCommissionInQuote', () => {
  it('values a quote-asset commission 1:1 without a ticker call', async () => {
    const client = fakeClient();
    const out = await valueCommissionInQuote(
      client,
      trade('0.5', 'USDT'),
      'BTC',
      'USDT',
      new Map(),
    );
    expect(out?.toString()).toBe('0.5');
    expect(client.getTicker24hr).not.toHaveBeenCalled();
  });

  it('values a base-asset SELL commission at the fill price', async () => {
    const out = await valueCommissionInQuote(
      fakeClient(),
      trade('0.01', 'BTC', '60000'),
      'BTC',
      'USDT',
      new Map(),
    );
    expect(out?.toString()).toBe('600'); // 0.01 BTC × 60000
  });

  it('values a base-asset BUY commission at zero — the cost basis already expensed it', async () => {
    // The BUY VWAP divides the quote paid by the fee-NET quantity, so the exit's
    // realised P/L has already carried this fee. Valuing it into feesQuote too
    // would subtract it a second time from netProfit.
    const out = await valueCommissionInQuote(
      fakeClient(),
      trade('0.01', 'BTC', '60000', true),
      'BTC',
      'USDT',
      new Map(),
    );
    expect(out?.toString()).toBe('0');
  });

  it('values another asset (BNB) via a {asset}{quote} ticker, cached per call', async () => {
    const client = fakeClient({ lastPrice: '500' });
    const cache = new Map<string, Decimal | null>();
    const a = await valueCommissionInQuote(client, trade('0.2', 'BNB'), 'BTC', 'USDT', cache);
    const b = await valueCommissionInQuote(client, trade('0.1', 'BNB'), 'BTC', 'USDT', cache);
    expect(a?.toString()).toBe('100'); // 0.2 × 500
    expect(b?.toString()).toBe('50'); // 0.1 × 500
    // Second call reused the cached BNBUSDT price — only one ticker fetch.
    expect(client.getTicker24hr).toHaveBeenCalledTimes(1);
  });

  it('returns null when an asset cannot be priced (so the caller skips, not guesses)', async () => {
    const out = await valueCommissionInQuote(
      fakeClient(new Error('invalid symbol')),
      trade('0.2', 'BNB'),
      'BTC',
      'USDT',
      new Map(),
    );
    expect(out).toBeNull();
  });

  it('short-circuits a zero commission to 0', async () => {
    const client = fakeClient();
    const out = await valueCommissionInQuote(client, trade('0', 'BNB'), 'BTC', 'USDT', new Map());
    expect(out?.toString()).toBe('0');
    expect(client.getTicker24hr).not.toHaveBeenCalled();
  });
});

const myTrade = (o: {
  orderId: number;
  commission: string;
  commissionAsset: string;
  price?: string;
  isBuyer?: boolean;
}): MyTradeDto =>
  ({
    id: o.orderId * 10,
    orderId: o.orderId,
    symbol: 'BTCUSDT',
    price: o.price ?? '100',
    qty: '1',
    quoteQty: '100',
    commission: o.commission,
    commissionAsset: o.commissionAsset,
    time: 0,
    isBuyer: o.isBuyer ?? false,
    isMaker: false,
  }) as MyTradeDto;

/** Deps stub exposing only the logger + client `resolveFees` actually reads. */
function depsFor(
  trades: readonly MyTradeDto[],
  ticker: { lastPrice: string } | Error,
): { deps: ArchiveGridTradeHandlerDeps; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const client = {
    getMyTrades: vi.fn(async () => trades),
    getTicker24hr: vi.fn(async () => {
      if (ticker instanceof Error) throw ticker;
      return ticker as never;
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

describe('resolveFees', () => {
  it('sums per-asset fees and the quote-valued total across priceable commissions', async () => {
    const { deps, warn } = depsFor(
      [
        myTrade({ orderId: 1, commission: '0.1', commissionAsset: 'USDT' }),
        myTrade({ orderId: 2, commission: '0.2', commissionAsset: 'BNB' }),
      ],
      { lastPrice: '5' }, // BNBUSDT = 5 → 0.2 × 5 = 1.0
    );
    const out = await resolveFees(deps, PAYLOAD, new Set([1, 2]), 'BTC', 'USDT');
    expect(out.fees).toEqual({ USDT: '0.1', BNB: '0.2' });
    expect(out.feesQuote).toBe('1.1'); // 0.1 quote + 1.0 BNB-in-quote
    expect(warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'pipeline_archive_grid_trade_fees_quote_unpriced',
    );
  });

  it('excludes an unpriceable commission from feesQuote and warns', async () => {
    const { deps, warn } = depsFor(
      [
        myTrade({ orderId: 1, commission: '0.1', commissionAsset: 'USDT' }),
        myTrade({ orderId: 2, commission: '0.2', commissionAsset: 'BNB' }),
      ],
      new Error('invalid symbol'), // BNB cannot be priced
    );
    const out = await resolveFees(deps, PAYLOAD, new Set([1, 2]), 'BTC', 'USDT');
    // BNB stays in the raw audit map but is left OUT of the quote total.
    expect(out.fees).toEqual({ USDT: '0.1', BNB: '0.2' });
    expect(out.feesQuote).toBe('0.1');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ unpricedTrades: 1 }),
      'pipeline_archive_grid_trade_fees_quote_unpriced',
    );
  });

  it('returns empty when there are no archived orders', async () => {
    const { deps } = depsFor([], { lastPrice: '5' });
    const out = await resolveFees(deps, PAYLOAD, new Set(), 'BTC', 'USDT');
    expect(out).toEqual({ fees: {}, feesQuote: '0' });
  });

  it('nets a base-asset-fee cycle to sellProceeds − sellFee − buyQuotePaid', async () => {
    // The live TSTUSDT cycle: BUY 1682.30 TST for 25.184031 USDT with a 1.6823
    // TST fee, protective SELL for 31.292772 USDT with a 0.03129277 USDT fee.
    // The BUY fee is coins the wallet never received, so the cost basis already
    // carries it; only the SELL fee is cash the operator paid on top.
    const BUY_QUOTE_PAID = new Decimal('25.184031');
    const SELL_PROCEEDS = new Decimal('31.292772');
    const SELL_FEE = new Decimal('0.03129277');
    const { deps } = depsFor(
      [
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
      ],
      new Error('no ticker needed'),
    );
    const out = await resolveFees(deps, PAYLOAD, new Set([1, 2]), 'TST', 'USDT');

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
