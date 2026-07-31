import { describe, expect, it } from 'vitest';
import type { MyTradeDto } from '@app/binance';

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
    const result = openPositionFromFills([
      fill({ id: 1, time: 1000, qty: '2', quoteQty: '20', isBuyer: true }), // 10/u
      fill({ id: 2, time: 2000, qty: '2', quoteQty: '30', isBuyer: true }), // 15/u
    ]);
    // (20 + 30) / (2 + 2) = 12.5
    expect(result).toEqual({ quantity: '4', avgEntryPrice: '12.5' });
  });

  it('buy + partial sell: average entry price unchanged, quantity reduced', () => {
    const result = openPositionFromFills([
      fill({ id: 1, time: 1000, qty: '10', quoteQty: '100', isBuyer: true }), // 10/u
      fill({ id: 2, time: 2000, qty: '4', quoteQty: '60', isBuyer: false }), // sell 4 @ 15
    ]);
    // Average stays 10; 6 units remain.
    expect(result).toEqual({ quantity: '6', avgEntryPrice: '10' });
  });

  it('buy fully sold returns null', () => {
    const result = openPositionFromFills([
      fill({ id: 1, time: 1000, qty: '5', quoteQty: '50', isBuyer: true }),
      fill({ id: 2, time: 2000, qty: '5', quoteQty: '70', isBuyer: false }),
    ]);
    expect(result).toBeNull();
  });

  it('two cycles leaving an open remainder: latest cycle prices the remainder', () => {
    const result = openPositionFromFills([
      fill({ id: 1, time: 1000, qty: '5', quoteQty: '50', isBuyer: true }), // cycle 1 buy @ 10
      fill({ id: 2, time: 2000, qty: '5', quoteQty: '70', isBuyer: false }), // cycle 1 fully sold
      fill({ id: 3, time: 3000, qty: '4', quoteQty: '80', isBuyer: true }), // cycle 2 buy @ 20
      fill({ id: 4, time: 4000, qty: '1', quoteQty: '25', isBuyer: false }), // partial sell, avg stays 20
    ]);
    expect(result).toEqual({ quantity: '3', avgEntryPrice: '20' });
  });

  it('empty fills returns null', () => {
    expect(openPositionFromFills([])).toBeNull();
  });

  it('oversized sell (sold more than this history bought) clamps to flat -> null', () => {
    const result = openPositionFromFills([
      fill({ id: 1, time: 1000, qty: '3', quoteQty: '30', isBuyer: true }),
      fill({ id: 2, time: 2000, qty: '5', quoteQty: '60', isBuyer: false }), // sells base from pre-history lump
    ]);
    expect(result).toBeNull();
  });

  it('a leading sell while flat nets to null (no open lot to reduce)', () => {
    // History opens with a SELL — the base came from a pre-history lump, so
    // the walk never accumulates an open quantity. The `openQty.gt(0)` arm
    // stays false and the position resolves flat.
    const result = openPositionFromFills([
      fill({ id: 1, time: 1000, qty: '5', quoteQty: '60', isBuyer: false }),
    ]);
    expect(result).toBeNull();
  });

  it('unsorted input is sorted oldest-first before the walk', () => {
    const result = openPositionFromFills([
      fill({ id: 2, time: 2000, qty: '4', quoteQty: '60', isBuyer: false }), // sell first in array
      fill({ id: 1, time: 1000, qty: '10', quoteQty: '100', isBuyer: true }), // buy earlier in time
    ]);
    // After sort: buy 10 @ 10, then sell 4 -> 6 remain @ 10.
    expect(result).toEqual({ quantity: '6', avgEntryPrice: '10' });
  });
});
