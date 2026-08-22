import { describe, expect, it } from 'vitest';
import type { MyTradeDto } from '@app/binance';
import { Decimal } from '@app/money';

import { openPositionFromFills } from '../../../src/queues/pipeline-handlers/open-position-from-fills.js';

// Minimal fill factory: only the fields the average-cost walk reads matter;
// the rest carry inert defaults so each case names just what it varies.
const fill = (
  over: Partial<MyTradeDto> & Pick<MyTradeDto, 'id' | 'time' | 'qty' | 'isBuyer'>,
): MyTradeDto => ({
  orderId: over.id,
  symbol: 'BTCUSDT',
  price: '0',
  quoteQty: '0',
  commission: '0',
  commissionAsset: 'USDT',
  isMaker: false,
  ...over,
});

describe('openPositionFromFills', () => {
  it('buys-only: sums quantity and averages cost across lots', () => {
    const result = openPositionFromFills(
      [
        fill({ id: 1, time: 1000, qty: '2', quoteQty: '20', isBuyer: true }), // 10/u
        fill({ id: 2, time: 2000, qty: '2', quoteQty: '30', isBuyer: true }), // 15/u
      ],
      'BTC',
    );
    // (20 + 30) / (2 + 2) = 12.5
    expect(result).toEqual({ quantity: '4', avgEntryPrice: '12.5' });
  });

  it('buy + partial sell: average entry price unchanged, quantity reduced', () => {
    const result = openPositionFromFills(
      [
        fill({ id: 1, time: 1000, qty: '10', quoteQty: '100', isBuyer: true }), // 10/u
        fill({ id: 2, time: 2000, qty: '4', quoteQty: '60', isBuyer: false }), // sell 4 @ 15
      ],
      'BTC',
    );
    // Average stays 10; 6 units remain.
    expect(result).toEqual({ quantity: '6', avgEntryPrice: '10' });
  });

  it('buy fully sold returns null', () => {
    const result = openPositionFromFills(
      [
        fill({ id: 1, time: 1000, qty: '5', quoteQty: '50', isBuyer: true }),
        fill({ id: 2, time: 2000, qty: '5', quoteQty: '70', isBuyer: false }),
      ],
      'BTC',
    );
    expect(result).toBeNull();
  });

  it('two cycles leaving an open remainder: latest cycle prices the remainder', () => {
    const result = openPositionFromFills(
      [
        fill({ id: 1, time: 1000, qty: '5', quoteQty: '50', isBuyer: true }), // cycle 1 buy @ 10
        fill({ id: 2, time: 2000, qty: '5', quoteQty: '70', isBuyer: false }), // cycle 1 fully sold
        fill({ id: 3, time: 3000, qty: '4', quoteQty: '80', isBuyer: true }), // cycle 2 buy @ 20
        fill({ id: 4, time: 4000, qty: '1', quoteQty: '25', isBuyer: false }), // partial sell, avg stays 20
      ],
      'BTC',
    );
    expect(result).toEqual({ quantity: '3', avgEntryPrice: '20' });
  });

  it('empty fills returns null', () => {
    expect(openPositionFromFills([], 'BTC')).toBeNull();
  });

  it('oversized sell (sold more than this history bought) clamps to flat -> null', () => {
    const result = openPositionFromFills(
      [
        fill({ id: 1, time: 1000, qty: '3', quoteQty: '30', isBuyer: true }),
        fill({ id: 2, time: 2000, qty: '5', quoteQty: '60', isBuyer: false }), // sells base from pre-history lump
      ],
      'BTC',
    );
    expect(result).toBeNull();
  });

  it('a leading sell while flat nets to null (no open lot to reduce)', () => {
    // History opens with a SELL — the base came from a pre-history lump, so
    // the walk never accumulates an open quantity. The `openQty.gt(0)` arm
    // stays false and the position resolves flat.
    const result = openPositionFromFills(
      [fill({ id: 1, time: 1000, qty: '5', quoteQty: '60', isBuyer: false })],
      'BTC',
    );
    expect(result).toBeNull();
  });

  it('nets a base-asset BUY commission out of the tracked quantity', () => {
    // Binance charges a spot BUY's fee on the asset received, so the account was credited 99.71 of the 100 the `qty` line claims. Walking gross accumulates a residue the wallet never held; the quote cost is deliberately not netted with it, so the average rises from the gross 0.4587 to the fee-netted figure the fill-adopter computes.
    const result = openPositionFromFills(
      [
        fill({
          id: 1,
          time: 1000,
          qty: '100',
          quoteQty: '45.87',
          isBuyer: true,
          commission: '0.29',
          commissionAsset: 'BTC',
          symbol: 'BTCUSDT',
        }),
      ],
      'BTC',
    );
    expect(result?.quantity).toBe('99.71');
    expect(result?.avgEntryPrice).toBe('0.46003409888677163775');
  });

  it('leaves a BNB-discounted or quote-asset commission out of the base quantity', () => {
    // Neither fee was taken from the base asset, so netting either would shrink a quantity it never touched. The walk compares each fee's asset against the base asset the caller names, so neither matches `BTC`.
    const result = openPositionFromFills(
      [
        fill({
          id: 1,
          time: 1000,
          qty: '10',
          quoteQty: '100',
          isBuyer: true,
          commission: '0.5',
          commissionAsset: 'BNB',
        }),
        fill({
          id: 2,
          time: 2000,
          qty: '10',
          quoteQty: '100',
          isBuyer: true,
          commission: '0.1',
          commissionAsset: 'USDT',
        }),
      ],
      'BTC',
    );
    expect(result).toEqual({ quantity: '20', avgEntryPrice: '10' });
  });

  it('nets a base-asset commission charged on a SELL, where the base IS the discount asset', () => {
    // A BNBUSDT sell with the BNB discount enabled pays its fee in BNB, and that BNB
    // leaves the same wallet line the position is denominated in. Keying the netting
    // off the fill's side instead of its fee asset would miss it and leave the walk
    // holding coins the account no longer has.
    const result = openPositionFromFills(
      [
        fill({ id: 1, time: 1000, qty: '10', quoteQty: '100', isBuyer: true, symbol: 'BNBUSDT' }),
        fill({
          id: 2,
          time: 2000,
          qty: '4',
          quoteQty: '60',
          isBuyer: false,
          symbol: 'BNBUSDT',
          commission: '0.5',
          commissionAsset: 'BNB',
        }),
      ],
      'BNB',
    );
    // 10 bought, 4 sold, 0.5 taken as fee -> 5.5 left; the average is untouched by a sale.
    expect(result).toEqual({ quantity: '5.5', avgEntryPrice: '10' });
  });

  it('ignores an unparseable commission rather than throwing', () => {
    const result = openPositionFromFills(
      [
        fill({
          id: 1,
          time: 1000,
          qty: '10',
          quoteQty: '100',
          isBuyer: true,
          commission: 'not-a-number',
          commissionAsset: 'BTC',
        }),
      ],
      'BTC',
    );
    expect(result).toEqual({ quantity: '10', avgEntryPrice: '10' });
  });

  it('ignores a non-positive commission', () => {
    // Absent means unknown, never a silent negative that would INFLATE the quantity.
    const result = openPositionFromFills(
      [
        fill({
          id: 1,
          time: 1000,
          qty: '10',
          quoteQty: '100',
          isBuyer: true,
          commission: '-1',
          commissionAsset: 'BTC',
        }),
      ],
      'BTC',
    );
    expect(result).toEqual({ quantity: '10', avgEntryPrice: '10' });
  });

  it('caps the reconstructed quantity at the wallet balance', () => {
    // A 1000-fill window can drop the sells that closed the earliest lots, so the walk can only ever over-state what is open. The cap keeps the ledger row from claiming coins the account does not hold; the average is the walk's own, since capping the size does not change what was paid per unit.
    const result = openPositionFromFills(
      [fill({ id: 1, time: 1000, qty: '10', quoteQty: '100', isBuyer: true })],
      'BTC',
      new Decimal('4'),
    );
    expect(result).toEqual({ quantity: '4', avgEntryPrice: '10' });
  });

  it('returns null when the wallet cap leaves nothing', () => {
    const result = openPositionFromFills(
      [fill({ id: 1, time: 1000, qty: '10', quoteQty: '100', isBuyer: true })],
      'BTC',
      new Decimal('0'),
    );
    expect(result).toBeNull();
  });

  it('unsorted input is sorted oldest-first before the walk', () => {
    const result = openPositionFromFills(
      [
        fill({ id: 2, time: 2000, qty: '4', quoteQty: '60', isBuyer: false }), // sell first in array
        fill({ id: 1, time: 1000, qty: '10', quoteQty: '100', isBuyer: true }), // buy earlier in time
      ],
      'BTC',
    );
    // After sort: buy 10 @ 10, then sell 4 -> 6 remain @ 10.
    expect(result).toEqual({ quantity: '6', avgEntryPrice: '10' });
  });
});
