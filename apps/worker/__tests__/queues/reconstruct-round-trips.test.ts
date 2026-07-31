// Pure round-trip reconstruction from Binance myTrades fills. No mocks: the
// function is I/O-free, so these assert the walk (BUY adds / SELL subtracts /
// emit on empty), GROSS profit + per-asset fees, multi-fill order grouping,
// epsilon dust tolerance, and the orphan/open-position drops.

import { describe, it, expect } from 'vitest';
import type { MyTradeDto } from '@app/binance';
import { reconstructRoundTrips } from '../../src/queues/pipeline-handlers/reconstruct-round-trips.js';

// Local "assert defined" to read array elements without the non-null operator
// (project convention, avoids `!`).
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error('expected a defined value');
  return v;
};

let seq = 0;
const trade = (o: {
  qty: string;
  quoteQty: string;
  isBuyer: boolean;
  time: number;
  id?: number;
  orderId?: number;
  commission?: string;
  commissionAsset?: string;
}): MyTradeDto => {
  const id = o.id ?? ++seq;
  return {
    id,
    orderId: o.orderId ?? id,
    symbol: 'WLDUSDT',
    price: '0',
    qty: o.qty,
    quoteQty: o.quoteQty,
    commission: o.commission ?? '0',
    commissionAsset: o.commissionAsset ?? 'USDT',
    time: o.time,
    isBuyer: o.isBuyer,
    isMaker: false,
  };
};

describe('reconstructRoundTrips', () => {
  it('builds one round-trip with gross profit, percent, breakdown, and closing marker', () => {
    const fills = [
      trade({ id: 1, qty: '100', quoteQty: '50', isBuyer: true, time: 1000 }),
      trade({ id: 2, qty: '100', quoteQty: '60', isBuyer: false, time: 2000 }),
    ];
    const { roundTrips, skippedOrphanSells } = reconstructRoundTrips(fills);
    expect(skippedOrphanSells).toBe(0);
    expect(roundTrips).toHaveLength(1);
    const rt = must(roundTrips[0]);
    expect(rt.totalBuyQuote).toBe('50');
    expect(rt.totalSellQuote).toBe('60');
    expect(rt.profit).toBe('10');
    expect(rt.profitPercent).toBe('20');
    expect(rt.breakdown).toEqual({ 'backfill:BUY': '50', 'backfill:SELL': '60' });
    expect(rt.closingTradeId).toBe(2);
    expect(rt.closedAtMs).toBe(2000);
  });

  it('reconstructs a loss-making exit with a negative profit', () => {
    const { roundTrips } = reconstructRoundTrips([
      trade({ qty: '30', quoteQty: '15', isBuyer: true, time: 1 }),
      trade({ qty: '30', quoteQty: '13', isBuyer: false, time: 2 }),
    ]);
    expect(must(roundTrips[0]).profit).toBe('-2');
  });

  it('groups multiple fills of one order and sums fees per commission asset', () => {
    const { roundTrips } = reconstructRoundTrips([
      trade({
        id: 1,
        orderId: 10,
        qty: '50',
        quoteQty: '25',
        isBuyer: true,
        time: 1,
        commission: '0.05',
        commissionAsset: 'BNB',
      }),
      trade({
        id: 2,
        orderId: 10,
        qty: '50',
        quoteQty: '25',
        isBuyer: true,
        time: 2,
        commission: '0.05',
        commissionAsset: 'BNB',
      }),
      trade({
        id: 3,
        orderId: 11,
        qty: '100',
        quoteQty: '60',
        isBuyer: false,
        time: 3,
        commission: '0.06',
        commissionAsset: 'USDT',
      }),
    ]);
    const rt = must(roundTrips[0]);
    expect(rt.orders).toHaveLength(2);
    const buy = must(rt.orders.find((o) => o.side === 'BUY'));
    expect(buy.binanceOrderId).toBe('10');
    expect(buy.qty).toBe('100');
    expect(buy.tradeIds).toEqual([1, 2]);
    expect(buy.clientOrderId).toBeNull();
    expect(rt.fees).toEqual({ BNB: '0.1', USDT: '0.06' });
    expect(rt.closingTradeId).toBe(3);
  });

  it('closes a round-trip despite base-asset fee dust via the relative epsilon', () => {
    const { roundTrips } = reconstructRoundTrips([
      trade({ qty: '100', quoteQty: '50', isBuyer: true, time: 1 }),
      trade({ qty: '99.9', quoteQty: '49.95', isBuyer: false, time: 2 }),
    ]);
    expect(roundTrips).toHaveLength(1);
  });

  it('does not close early on a genuine partial sell', () => {
    const { roundTrips } = reconstructRoundTrips([
      trade({ qty: '100', quoteQty: '50', isBuyer: true, time: 1 }),
      trade({ qty: '40', quoteQty: '24', isBuyer: false, time: 2 }),
      trade({ qty: '60', quoteQty: '40', isBuyer: false, time: 3 }),
    ]);
    expect(roundTrips).toHaveLength(1);
    expect(must(roundTrips[0]).totalSellQuote).toBe('64');
  });

  it('emits two separate round-trips for two complete cycles', () => {
    const { roundTrips } = reconstructRoundTrips([
      trade({ qty: '10', quoteQty: '5', isBuyer: true, time: 1 }),
      trade({ qty: '10', quoteQty: '6', isBuyer: false, time: 2 }),
      trade({ qty: '10', quoteQty: '7', isBuyer: true, time: 3 }),
      trade({ qty: '10', quoteQty: '8', isBuyer: false, time: 4 }),
    ]);
    expect(roundTrips).toHaveLength(2);
    expect(must(roundTrips[1]).profit).toBe('1');
  });

  it('skips an orphan leading sell with no open position', () => {
    const { roundTrips, skippedOrphanSells } = reconstructRoundTrips([
      trade({ qty: '5', quoteQty: '3', isBuyer: false, time: 1 }),
      trade({ qty: '10', quoteQty: '5', isBuyer: true, time: 2 }),
      trade({ qty: '10', quoteQty: '6', isBuyer: false, time: 3 }),
    ]);
    expect(skippedOrphanSells).toBe(1);
    expect(roundTrips).toHaveLength(1);
  });

  it('drops an overshoot cycle that sells more base than it bought (un-costed surplus)', () => {
    // Bought 100 in-window, sold 150 (the extra 50 came from a pre-history
    // ghost BUY). Counting the 75 sell quote as profit would inflate P/L, so
    // the cycle is dropped and counted, not emitted.
    const { roundTrips, droppedOvershootCycles } = reconstructRoundTrips([
      trade({ qty: '100', quoteQty: '50', isBuyer: true, time: 1 }),
      trade({ qty: '150', quoteQty: '75', isBuyer: false, time: 2 }),
    ]);
    expect(droppedOvershootCycles).toBe(1);
    expect(roundTrips).toHaveLength(0);
  });

  it('drops the overshoot cycle but still reconstructs a later clean cycle', () => {
    const { roundTrips, droppedOvershootCycles } = reconstructRoundTrips([
      trade({ qty: '100', quoteQty: '50', isBuyer: true, time: 1 }),
      trade({ qty: '150', quoteQty: '75', isBuyer: false, time: 2 }),
      trade({ qty: '10', quoteQty: '5', isBuyer: true, time: 3 }),
      trade({ qty: '10', quoteQty: '7', isBuyer: false, time: 4 }),
    ]);
    expect(droppedOvershootCycles).toBe(1);
    expect(roundTrips).toHaveLength(1);
    expect(must(roundTrips[0]).profit).toBe('2');
  });

  it('treats a tiny negative running (dust overshoot) as a normal close, not a drop', () => {
    const { roundTrips, droppedOvershootCycles } = reconstructRoundTrips([
      trade({ qty: '100', quoteQty: '50', isBuyer: true, time: 1 }),
      trade({ qty: '100.5', quoteQty: '60', isBuyer: false, time: 2 }),
    ]);
    expect(droppedOvershootCycles).toBe(0);
    expect(roundTrips).toHaveLength(1);
  });

  it('drops a trailing open position that was never fully sold', () => {
    const { roundTrips } = reconstructRoundTrips([
      trade({ qty: '10', quoteQty: '5', isBuyer: true, time: 1 }),
      trade({ qty: '10', quoteQty: '6', isBuyer: false, time: 2 }),
      trade({ qty: '50', quoteQty: '25', isBuyer: true, time: 3 }),
    ]);
    expect(roundTrips).toHaveLength(1);
  });

  it('sorts unordered fills by time before walking', () => {
    const { roundTrips } = reconstructRoundTrips([
      trade({ id: 2, qty: '10', quoteQty: '6', isBuyer: false, time: 2000 }),
      trade({ id: 1, qty: '10', quoteQty: '5', isBuyer: true, time: 1000 }),
    ]);
    expect(roundTrips).toHaveLength(1);
    expect(must(roundTrips[0]).profit).toBe('1');
  });
});
