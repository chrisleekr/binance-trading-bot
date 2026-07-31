import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { Clock, Decision, ExecutorContext } from '@app/strategy-core';
import { BacktestExecutor } from '../src/executor.js';
import { IdealFillModel } from '../src/ideal-fill.js';
import { singleCandle, SYMBOL, SYMBOL_INFO } from './_fixtures.js';

const clock: Clock = { nowMs: () => 1_000 };
const ctx: ExecutorContext = { userId: 'u', profileId: 'p', clock, strategyName: 'test' };
const candle = singleCandle('100');

function makeExecutor(usdt = '1000') {
  const ex = new BacktestExecutor(new IdealFillModel(), { USDT: usdt }, [SYMBOL_INFO]);
  ex.setMarketContext(SYMBOL, new Decimal('100'), candle);
  return ex;
}

const buy = (qty: string): Decision => ({
  type: 'place-order',
  intent: { symbol: SYMBOL, side: 'BUY', reason: 'manual', clientOrderId: 'c1' },
  params: { type: 'MARKET', quantity: qty },
});
const sell = (qty: string): Decision => ({
  type: 'place-order',
  intent: { symbol: SYMBOL, side: 'SELL', reason: 'manual', clientOrderId: 'c2' },
  params: { type: 'MARKET', quantity: qty },
});

describe('BacktestExecutor', () => {
  it('a BUY fill debits quote and credits base; records a trade', async () => {
    const ex = makeExecutor('1000');
    const res = await ex.apply(ctx, buy('2'));
    expect(res.ok).toBe(true);
    const acct = ex.snapshotAccount();
    expect(acct.balances['USDT']?.free.toString()).toBe('800'); // 1000 - 2*100
    expect(acct.balances['BTC']?.free.toString()).toBe('2');
    expect(ex.getTrades()).toHaveLength(1);
    expect(ex.getTrades()[0]).toMatchObject({ side: 'BUY', price: '100', qty: '2', feeQuote: '0' });
  });

  it('a SELL fill debits base and credits quote', async () => {
    const ex = makeExecutor('1000');
    await ex.apply(ctx, buy('2'));
    await ex.apply(ctx, sell('1'));
    const acct = ex.snapshotAccount();
    expect(acct.balances['BTC']?.free.toString()).toBe('1');
    expect(acct.balances['USDT']?.free.toString()).toBe('900'); // 800 + 1*100
  });

  it('rejects a BUY that exceeds the quote balance (no negative balance)', async () => {
    const ex = makeExecutor('50'); // only 50 USDT, buy needs 100
    await ex.apply(ctx, buy('1'));
    expect(ex.getTrades()).toHaveLength(0);
    expect(ex.snapshotAccount().balances['USDT']?.free.toString()).toBe('50');
  });

  it('rejects a SELL that exceeds the base balance', async () => {
    const ex = makeExecutor('1000'); // 0 BTC held
    await ex.apply(ctx, sell('1'));
    expect(ex.getTrades()).toHaveLength(0);
    expect(ex.snapshotAccount().balances['BTC']?.free.toString() ?? '0').toBe('0');
  });

  it('the ideal model fills regardless of minNotional/stepSize filters', async () => {
    const strictInfo = {
      ...SYMBOL_INFO,
      filters: { ...SYMBOL_INFO.filters, minNotional: '1000', stepSize: '1' },
    };
    const ex = new BacktestExecutor(new IdealFillModel(), { USDT: '1000' }, [strictInfo]);
    ex.setMarketContext(SYMBOL, new Decimal('100'), candle);
    // notional 0.3 USDT « minNotional 1000, qty 0.003 not a multiple of step 1 —
    // the ideal arm ignores both and fills anyway.
    await ex.apply(ctx, buy('0.003'));
    expect(ex.getTrades()).toHaveLength(1);
    expect(ex.snapshotAccount().balances['BTC']?.free.toString()).toBe('0.003');
  });

  it('noop and cancel-order are ok and mutate nothing', async () => {
    const ex = makeExecutor('1000');
    expect((await ex.apply(ctx, { type: 'noop' })).ok).toBe(true);
    expect((await ex.apply(ctx, { type: 'cancel-order', orderId: 1, reason: 'x' })).ok).toBe(true);
    expect(ex.getTrades()).toHaveLength(0);
    expect(ex.openOrders()).toEqual([]);
  });

  it('emit-event is ring-buffered', async () => {
    const ex = makeExecutor('1000');
    const ev: Decision = {
      type: 'emit-event',
      eventType: 'thing',
      payload: { a: 1 },
    } as Decision;
    await ex.apply(ctx, ev);
    expect(ex.getEvents()).toEqual([{ eventType: 'thing', payload: { a: 1 } }]);
  });

  it('equityInQuote marks base holdings at the last price', async () => {
    const ex = makeExecutor('1000');
    await ex.apply(ctx, buy('2')); // 800 USDT + 2 BTC @100 = 1000
    expect(ex.equityInQuote('USDT').toString()).toBe('1000');
    ex.setMarketContext(SYMBOL, new Decimal('150'), candle); // BTC up 50%
    expect(ex.equityInQuote('USDT').toString()).toBe('1100'); // 800 + 2*150
  });

  it('fails an unknown symbol without throwing', async () => {
    const ex = makeExecutor('1000');
    const res = await ex.apply(ctx, {
      type: 'place-order',
      intent: { symbol: 'ETHUSDT', side: 'BUY', reason: 'manual', clientOrderId: 'c' },
      params: { type: 'MARKET', quantity: '1' },
    });
    expect(res.ok).toBe(false);
  });
});
