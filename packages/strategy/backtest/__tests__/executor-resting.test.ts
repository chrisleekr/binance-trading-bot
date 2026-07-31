import { describe, expect, it, vi } from 'vitest';
import { Decimal } from '@app/money';
import type { Candle, Clock, Decision, ExecutorContext } from '@app/strategy-core';
import { BacktestExecutor } from '../src/executor.js';
import { OhlcvFillModel } from '../src/ohlcv-fill.js';
import { SYMBOL, SYMBOL_INFO } from './_fixtures.js';

function bar(ts: number, low: string, high: string, open = low, close = high): Candle {
  return {
    openTimeMs: ts,
    closeTimeMs: ts + 59_999,
    open,
    high,
    low,
    close,
    volume: '1',
    isClosed: true,
  };
}

const ctxAt = (ms: number): ExecutorContext => {
  const clock: Clock = { nowMs: () => ms };
  return { userId: 'u', profileId: 'p', clock, strategyName: 'test' };
};

const limitBuy = (price: string, qty: string): Decision => ({
  type: 'place-order',
  intent: { symbol: SYMBOL, side: 'BUY', reason: 'grid-buy', clientOrderId: 'g1' },
  params: { type: 'LIMIT', price, quantity: qty },
});

function makeExecutor() {
  return new BacktestExecutor(
    new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
    { USDT: '10000' },
    [SYMBOL_INFO],
  );
}

describe('BacktestExecutor with a realistic (resting) fill model', () => {
  it('rests an order on placement and reports it via openOrders', async () => {
    const ex = makeExecutor();
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    await ex.apply(ctxAt(0), limitBuy('95', '1'));
    expect(ex.getTrades()).toHaveLength(0); // not filled on placement candle
    const open = ex.openOrders();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ side: 'BUY', type: 'LIMIT', price: '95', origQty: '1' });
  });

  it('skips the per-candle resting loop (no snapshotAccount) when the symbol has no resting order', async () => {
    const ex = makeExecutor();
    const spy = vi.spyOn(ex, 'snapshotAccount');
    // Empty book: advancing the symbol's candle must not enter the per-order
    // loop, so it allocates no `next` array and takes no account snapshot.
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    expect(spy).not.toHaveBeenCalled();
    // With a resting order for the symbol, advancing its candle DOES evaluate
    // it (one snapshot per evaluated order). A candle that never crosses 95
    // leaves it resting.
    await ex.apply(ctxAt(0), limitBuy('95', '1'));
    spy.mockClear();
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(60_000, '98', '102'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ex.openOrders()).toHaveLength(1);
  });

  it('fills the resting order on a later candle whose low crosses the limit', async () => {
    const ex = makeExecutor();
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    await ex.apply(ctxAt(0), limitBuy('95', '1'));
    // next candle dips to 94 — crosses the 95 limit
    ex.setMarketContext(SYMBOL, new Decimal('96'), bar(60_000, '94', '100'));
    expect(ex.getTrades()).toHaveLength(1);
    expect(ex.getTrades()[0]).toMatchObject({ side: 'BUY', price: '95', qty: '1' });
    expect(ex.openOrders()).toHaveLength(0); // left the book after filling
    expect(ex.snapshotAccount().balances['BTC']?.free.toString()).toBe('1');
  });

  it('keeps resting across candles that never reach the limit', async () => {
    const ex = makeExecutor();
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    await ex.apply(ctxAt(0), limitBuy('95', '1'));
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(60_000, '98', '102'));
    ex.setMarketContext(SYMBOL, new Decimal('101'), bar(120_000, '99', '103'));
    expect(ex.getTrades()).toHaveLength(0);
    expect(ex.openOrders()).toHaveLength(1);
  });

  it('cancel-order removes a resting order before it can fill', async () => {
    const ex = makeExecutor();
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    await ex.apply(ctxAt(0), limitBuy('95', '1'));
    const orderId = ex.openOrders()[0]?.orderId ?? -1;
    await ex.apply(ctxAt(0), { type: 'cancel-order', orderId, reason: 'grid-reset' });
    expect(ex.openOrders()).toHaveLength(0);
    ex.setMarketContext(SYMBOL, new Decimal('90'), bar(60_000, '90', '96'));
    expect(ex.getTrades()).toHaveLength(0); // cancelled, so no fill even though price crossed
  });

  it('rejects (drops) a resting buy the balance cannot fully fund when it crosses', async () => {
    // 1000 USDT, no fee; buy 20 BTC @ 100 = 2000 needed. Binance rejects an
    // underfunded order (-2010) rather than partial-filling it, so when the limit
    // is crossed the order is dropped, not silently shrunk to the affordable 10.
    const ex = new BacktestExecutor(
      new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
      { USDT: '1000' },
      [SYMBOL_INFO],
    );
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    await ex.apply(ctxAt(0), limitBuy('100', '20'));
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(60_000, '99', '101'));
    expect(ex.getTrades()).toHaveLength(0); // underfunded → rejected, no fill
    expect(ex.openOrders()).toHaveLength(0); // dropped from the book
  });

  it('tracks origQty and executedQty across a volume-cap partial fill', async () => {
    // A resting buy the per-bar volume cap can only partly fill re-rests the
    // remainder, reporting the immutable origQty and the accumulated executedQty
    // — so a strategy's `executedQty > 0` guard (the grid never re-prices a
    // partially filled order) fires in backtest exactly as it does live.
    const ex = new BacktestExecutor(
      new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0, volumeCapPct: 50 }),
      { USDT: '10000' },
      [SYMBOL_INFO],
    );
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    await ex.apply(ctxAt(0), limitBuy('100', '1'));
    // bar volume 1, cap 50% → only 0.5 fills; remainder 0.5 re-rests.
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(60_000, '99', '101'));
    expect(ex.getTrades()).toHaveLength(1);
    expect(ex.getTrades()[0]?.qty).toBe('0.5');
    const open = ex.openOrders();
    expect(open).toHaveLength(1);
    expect(open[0]?.origQty).toBe('1'); // immutable original placed quantity
    expect(open[0]?.executedQty).toBe('0.5'); // accumulated fill
  });

  it('keeps a protective stop-limit resting when a bar gaps past its limit, then fills on recovery', async () => {
    // A SELL stop-limit (stop 95 / limit 94) arms when price falls to the stop
    // but its limit sell cannot fill while the whole bar trades below 94 — the
    // position rides unprotected. It fills only once a later bar recovers through
    // the limit, at the limit price.
    const ex = new BacktestExecutor(
      new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
      { USDT: '10000', BTC: '1' },
      [SYMBOL_INFO],
    );
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    await ex.apply(ctxAt(0), {
      type: 'place-order',
      intent: { symbol: SYMBOL, side: 'SELL', reason: 'stop-loss', clientOrderId: 's1' },
      params: { type: 'STOP_LOSS_LIMIT', stopPrice: '95', price: '94', quantity: '1' },
    });
    // Gap-down bar: armed (low 90 <= 95) but high 93 < limit 94 → rests unfilled.
    ex.setMarketContext(SYMBOL, new Decimal('92'), bar(60_000, '90', '93'));
    expect(ex.getTrades()).toHaveLength(0);
    expect(ex.openOrders()).toHaveLength(1);
    // Recovery bar rises back through the limit → fills at 94.
    ex.setMarketContext(SYMBOL, new Decimal('96'), bar(120_000, '93', '97'));
    expect(ex.getTrades()).toHaveLength(1);
    expect(ex.getTrades()[0]).toMatchObject({ side: 'SELL', price: '94' });
    expect(ex.openOrders()).toHaveLength(0);
  });

  it('only evaluates resting orders for the symbol whose context advanced', async () => {
    const ethInfo = { ...SYMBOL_INFO, symbol: 'ETHUSDT', baseAsset: 'ETH' };
    const ex = new BacktestExecutor(
      new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
      { USDT: '10000' },
      [SYMBOL_INFO, ethInfo],
    );
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    ex.setMarketContext('ETHUSDT', new Decimal('50'), bar(0, '49', '51'));
    await ex.apply(ctxAt(0), limitBuy('95', '1')); // BTC order
    await ex.apply(ctxAt(0), {
      type: 'place-order',
      intent: { symbol: 'ETHUSDT', side: 'BUY', reason: 'grid-buy', clientOrderId: 'e1' },
      params: { type: 'LIMIT', price: '45', quantity: '1' },
    });
    expect(ex.openOrders()).toHaveLength(2);
    // advance only ETH below its limit → only the ETH order fills; BTC stays
    ex.setMarketContext('ETHUSDT', new Decimal('44'), bar(60_000, '44', '50'));
    expect(ex.getTrades()).toHaveLength(1);
    expect(ex.getTrades()[0]?.symbol).toBe('ETHUSDT');
    expect(ex.openOrders().map((o) => o.symbol)).toEqual([SYMBOL]); // BTC order untouched
  });

  it('fills multiple grid levels as price falls through them', async () => {
    const ex = makeExecutor();
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    await ex.apply(ctxAt(0), limitBuy('95', '1'));
    await ex.apply(ctxAt(0), limitBuy('90', '1'));
    expect(ex.openOrders()).toHaveLength(2);
    // a candle that dips to 88 crosses both 95 and 90
    ex.setMarketContext(SYMBOL, new Decimal('92'), bar(60_000, '88', '100'));
    expect(ex.getTrades()).toHaveLength(2);
    expect(ex.openOrders()).toHaveLength(0);
    expect(ex.snapshotAccount().balances['BTC']?.free.toString()).toBe('2');
  });
});

describe('BacktestExecutor — resting orders lock funds (real-exchange parity)', () => {
  it('locks a resting buy’s quote (free→locked), then settles it on fill', async () => {
    const ex = makeExecutor(); // 10000 USDT, no fee
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    await ex.apply(ctxAt(0), limitBuy('95', '1')); // commits 95 quote
    // Resting: the 95 it will spend is moved free→locked, so it is unspendable.
    let usdt = ex.snapshotAccount().balances['USDT'];
    expect(usdt?.free.toString()).toBe('9905');
    expect(usdt?.locked.toString()).toBe('95');
    // Fill at 95: the lock is released and the actual cost leaves free.
    ex.setMarketContext(SYMBOL, new Decimal('96'), bar(60_000, '94', '100'));
    usdt = ex.snapshotAccount().balances['USDT'];
    expect(usdt?.free.toString()).toBe('9905'); // 10000 − 95 spent
    expect(usdt?.locked.toString()).toBe('0');
    expect(ex.snapshotAccount().balances['BTC']?.free.toString()).toBe('1');
  });

  it('returns the locked funds to free when a resting order is cancelled', async () => {
    const ex = makeExecutor();
    ex.setMarketContext(SYMBOL, new Decimal('100'), bar(0, '99', '101'));
    await ex.apply(ctxAt(0), limitBuy('95', '1'));
    expect(ex.snapshotAccount().balances['USDT']?.locked.toString()).toBe('95');
    const orderId = ex.openOrders()[0]?.orderId ?? -1;
    await ex.apply(ctxAt(0), { type: 'cancel-order', orderId, reason: 'grid-reset' });
    const usdt = ex.snapshotAccount().balances['USDT'];
    expect(usdt?.locked.toString()).toBe('0');
    expect(usdt?.free.toString()).toBe('10000'); // fully returned
  });

  it('never lets two resting buys claim the same cash (the double-spend guard)', async () => {
    // 100 USDT; two limit buys of 1 @ 60 would need 120 total. Live, the first
    // order's 60 is locked, so the second can only lock the remaining 40 — the
    // account never funds both at 60. Before locking, both rested reserving
    // nothing, so the backtest let the same 60 back two orders (over-deployment).
    const ex = new BacktestExecutor(
      new OhlcvFillModel({ makerBps: 0, takerBps: 0, slippageBps: 0 }),
      { USDT: '100' },
      [SYMBOL_INFO],
    );
    ex.setMarketContext(SYMBOL, new Decimal('60'), bar(0, '59', '61'));
    await ex.apply(ctxAt(0), {
      type: 'place-order',
      intent: { symbol: SYMBOL, side: 'BUY', reason: 'grid-buy', clientOrderId: 'a' },
      params: { type: 'LIMIT', price: '60', quantity: '1' },
    });
    await ex.apply(ctxAt(0), {
      type: 'place-order',
      intent: { symbol: SYMBOL, side: 'BUY', reason: 'grid-buy', clientOrderId: 'b' },
      params: { type: 'LIMIT', price: '60', quantity: '1' },
    });
    const usdt = ex.snapshotAccount().balances['USDT'];
    expect(usdt?.locked.toString()).toBe('100'); // 60 + the remaining 40, not 120
    expect(usdt?.free.toString()).toBe('0');
  });
});
