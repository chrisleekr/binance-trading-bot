import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type {
  AccountSnapshot,
  Candle,
  Clock,
  Decision,
  OrderParams,
  OrderSide,
} from '@app/strategy-core';

import { BacktestExecutor } from '../src/executor.js';
import { OhlcvFillModel, type OhlcvFillModelOptions } from '../src/ohlcv-fill.js';
import type { FillInput, FillOutcome } from '../src/types.js';
import { SYMBOL, SYMBOL_INFO } from './_fixtures.js';

const clock: Clock = { nowMs: () => 1_000 };

interface Ohlc {
  readonly open?: string;
  readonly low: string;
  readonly high: string;
  readonly close?: string;
  readonly volume?: string;
}

const bar = ({ open, low, high, close, volume }: Ohlc, openTimeMs = 0): Candle => ({
  openTimeMs,
  closeTimeMs: openTimeMs + 59_999,
  open: open ?? low,
  high,
  low,
  close: close ?? high,
  volume: volume ?? '1000',
  isClosed: true,
});

const ACCOUNT: AccountSnapshot = {
  readable: true,
  balances: {
    USDT: { asset: 'USDT', free: new Decimal('100000'), locked: new Decimal(0) },
    BTC: { asset: 'BTC', free: new Decimal('10'), locked: new Decimal(0) },
  },
};

const input = (
  side: OrderSide,
  params: OrderParams,
  detail: readonly Candle[],
  armed = false,
): FillInput => {
  const last = detail[0] as Candle;
  return {
    intent: { symbol: SYMBOL, side, reason: 'manual', clientOrderId: 'c1' },
    params,
    market: { lastPrice: new Decimal(last.close), lastCandle: last, detailCandles: detail },
    account: ACCOUNT,
    symbolInfo: SYMBOL_INFO,
    clock,
    phase: 'resting',
    armed,
  };
};

const COSTS: OhlcvFillModelOptions = {
  makerBps: 10,
  takerBps: 20,
  slippageBps: 50,
  spreadBps: 20,
};
const model = new OhlcvFillModel(COSTS);

// Reduces an outcome to the price and fee of its only fill, or its rest flag, so one toEqual pins all of it.
const summary = (outcome: FillOutcome): unknown => {
  if (outcome.kind === 'rest') return { kind: 'rest', armed: outcome.armed === true };
  if (outcome.kind === 'rejected') return { kind: 'rejected', reason: outcome.reason };
  return {
    kind: outcome.kind,
    price: outcome.fills[0]?.price.toString(),
    feeBps: outcome.fills[0]?.feeBps,
  };
};

const limit = (price: string): OrderParams => ({ type: 'LIMIT', price, quantity: '1' });
const stopLimit = (stopPrice: string, price: string): OrderParams => ({
  type: 'STOP_LOSS_LIMIT',
  stopPrice,
  price,
  quantity: '1',
});
const REST_UNARMED = { kind: 'rest', armed: false };
const REST_ARMED = { kind: 'rest', armed: true };

describe('never executes beyond limit at any spread; touch does not fill; spread applies to the cross', () => {
  it.each([5, 20, 200])(
    'fills a BUY LIMIT at exactly its limit with a %d bps spread',
    (spreadBps) => {
      const out = new OhlcvFillModel({ ...COSTS, spreadBps }).fill(
        input('BUY', limit('100'), [bar({ low: '90', high: '105' })]),
      );
      expect(summary(out)).toEqual({ kind: 'filled', price: '100', feeBps: 10 });
    },
  );

  it.each([5, 20, 200])(
    'fills a SELL LIMIT at exactly its limit with a %d bps spread',
    (spreadBps) => {
      const out = new OhlcvFillModel({ ...COSTS, spreadBps }).fill(
        input('SELL', limit('110'), [bar({ low: '100', high: '120' })]),
      );
      expect(summary(out)).toEqual({ kind: 'filled', price: '110', feeBps: 10 });
    },
  );

  it('does not fill a BUY LIMIT on a touch', () => {
    const out = model.fill(input('BUY', limit('100'), [bar({ low: '100', high: '110' })]));
    expect(summary(out)).toEqual(REST_UNARMED);
  });

  it('does not fill a SELL LIMIT on a touch', () => {
    const out = model.fill(input('SELL', limit('110'), [bar({ low: '100', high: '110' })]));
    expect(summary(out)).toEqual(REST_UNARMED);
  });

  it('keeps a BUY LIMIT resting when the low crosses it only before the half-spread', () => {
    // 99.95 x 1.001 = 100.04995, which does not reach below the limit once the spread is paid.
    const out = model.fill(input('BUY', limit('100'), [bar({ low: '99.95', high: '110' })]));
    expect(summary(out)).toEqual(REST_UNARMED);
  });

  it('fills a BUY LIMIT when the low crosses it after the half-spread', () => {
    // 99.8 x 1.001 = 99.8998, below the limit.
    const out = model.fill(input('BUY', limit('100'), [bar({ low: '99.8', high: '110' })]));
    expect(summary(out)).toEqual({ kind: 'filled', price: '100', feeBps: 10 });
  });

  it('treats a spread-adjusted BUY touch as no fill', () => {
    // 100 x 1.001 = 100.1 exactly, so the strict cross is not met.
    const out = model.fill(input('BUY', limit('100.1'), [bar({ low: '100', high: '110' })]));
    expect(summary(out)).toEqual(REST_UNARMED);
  });

  it('keeps a SELL LIMIT resting when the high crosses it only before the half-spread', () => {
    // 110.05 x 0.999 = 109.93995, which does not reach above the limit once the spread is paid.
    const out = model.fill(input('SELL', limit('110'), [bar({ low: '100', high: '110.05' })]));
    expect(summary(out)).toEqual(REST_UNARMED);
  });

  it('fills a SELL LIMIT when the high crosses it after the half-spread', () => {
    // 110.2 x 0.999 = 110.0898, above the limit.
    const out = model.fill(input('SELL', limit('110'), [bar({ low: '100', high: '110.2' })]));
    expect(summary(out)).toEqual({ kind: 'filled', price: '110', feeBps: 10 });
  });
});

describe('candidate outside limit rests armed, no clamp; later cross fills at limit as maker; trigger bar assumes no recovery', () => {
  // Trigger 100 less 50 bps slippage and 10 bps half-spread is 99.4005, below this 99.9 limit.
  const SELL_TIGHT = stopLimit('100', '99.9');
  const SELL_BAR = { open: '100.5', low: '99', high: '101' };

  it('rests a SELL stop-limit armed when its candidate is below the limit', () => {
    const out = model.fill(input('SELL', SELL_TIGHT, [bar(SELL_BAR)]));
    expect(summary(out)).toEqual(REST_ARMED);
  });

  it('rests a BUY stop-limit armed when its candidate is above the limit', () => {
    // Trigger 100 plus 50 bps slippage and 10 bps half-spread is 100.6005, above this 100.1 limit.
    const out = model.fill(
      input('BUY', stopLimit('100', '100.1'), [bar({ open: '99.5', low: '99', high: '101' })]),
    );
    expect(summary(out)).toEqual(REST_ARMED);
  });

  it('prices a gap through the stop from the open and rests when that is outside the limit', () => {
    const out = model.fill(
      input('SELL', stopLimit('100', '99'), [bar({ open: '98', low: '97.5', high: '99.5' })]),
    );
    expect(summary(out)).toEqual(REST_ARMED);
  });

  it('assumes no recovery on the trigger bar however far it later traded', () => {
    const out = model.fill(
      input('SELL', stopLimit('100', '99'), [bar({ open: '98', low: '97', high: '105' })]),
    );
    expect(summary(out)).toEqual(REST_ARMED);
  });

  it('fills on a later bar of the same evaluation at the limit as maker', () => {
    const out = model.fill(
      input('SELL', stopLimit('100', '99'), [
        bar({ open: '98', low: '97', high: '105' }),
        bar({ open: '98', low: '97', high: '100' }, 60_000),
      ]),
    );
    expect(summary(out)).toEqual({ kind: 'filled', price: '99', feeBps: 10 });
  });

  it('fills an already-armed order at the limit as maker without crossing the stop again', () => {
    // The bar stays above the 100 stop, so only the persisted activation can fill it.
    const out = model.fill(
      input('SELL', stopLimit('100', '99.9'), [bar({ low: '100.2', high: '100.5' })], true),
    );
    expect(summary(out)).toEqual({ kind: 'filled', price: '99.9', feeBps: 10 });
  });

  it('keeps an already-armed order armed on a touch of its limit', () => {
    const out = model.fill(
      input('SELL', stopLimit('100', '99.9'), [bar({ low: '99', high: '99.9' })], true),
    );
    expect(summary(out)).toEqual(REST_ARMED);
  });

  it('fills a candidate inside the limit immediately as taker', () => {
    const out = model.fill(input('SELL', stopLimit('100', '95'), [bar(SELL_BAR)]));
    expect(summary(out)).toEqual({ kind: 'filled', price: '99.4005', feeBps: 20 });
  });
});

describe('new or replaced order starts unarmed; partial remainder stays armed; reservation conserved', () => {
  const ctx: Parameters<BacktestExecutor['apply']>[0] = {
    userId: 'u',
    profileId: 'p',
    clock,
    strategyName: 'test',
  };
  const NO_SLIP = { makerBps: 10, takerBps: 20, slippageBps: 0 };
  const intent = (side: OrderSide) =>
    ({ symbol: SYMBOL, side, reason: 'manual', clientOrderId: 'c1' }) as const;
  const place = (side: OrderSide, params: OrderParams): Decision => ({
    type: 'place-order',
    intent: intent(side),
    params,
  });
  const executor = (opts: OhlcvFillModelOptions) =>
    new BacktestExecutor(new OhlcvFillModel(opts), { USDT: '10000', BTC: '10' }, [SYMBOL_INFO]);
  const step = (ex: BacktestExecutor, ohlc: Ohlc, minute: number): void => {
    const candle = bar(ohlc, minute * 60_000);
    ex.setMarketContext(SYMBOL, new Decimal(candle.close), candle, [candle]);
  };
  const FLAT = { open: '101', low: '100.5', high: '102' };
  // Gapped through both prices, so it activates the stop and cannot fill on that bar.
  const GAP = { open: '98', low: '97.5', high: '98.5' };
  // Trades through the 99 limit while staying above the 100 stop, so only an activated order fills.
  const ABOVE_STOP = { open: '101', low: '100.5', high: '103' };
  const SELL = stopLimit('100', '99');

  it('does not treat a new order as activated', async () => {
    const ex = executor(NO_SLIP);
    step(ex, FLAT, 0);
    await ex.apply(ctx, place('SELL', SELL));
    step(ex, ABOVE_STOP, 1);
    expect(ex.getTrades()).toEqual([]);
  });

  it('does not carry activation onto a replacement order', async () => {
    const ex = executor(NO_SLIP);
    step(ex, FLAT, 0);
    await ex.apply(ctx, place('SELL', SELL));
    step(ex, GAP, 1);
    const orderId = ex.openOrders()[0]?.orderId;
    await ex.apply(ctx, {
      type: 'replace-order',
      cancelOrderId: orderId as number,
      reason: 'move the stop',
      intent: intent('SELL'),
      params: SELL,
    });
    step(ex, ABOVE_STOP, 2);
    expect(ex.getTrades()).toEqual([]);
  });

  it('persists activation across bars and fills later at the limit as maker', async () => {
    const ex = executor(NO_SLIP);
    step(ex, FLAT, 0);
    await ex.apply(ctx, place('SELL', SELL));
    step(ex, GAP, 1);
    step(ex, ABOVE_STOP, 2);
    expect(ex.getTrades().map((t) => [t.price, t.feeQuote])).toEqual([['99', '0.099']]);
  });

  it('keeps a partial remainder activated and charges maker on its later resting fill', async () => {
    const ex = executor({ ...NO_SLIP, volumeCapPct: 50 });
    const volume = { volume: '1' };
    step(ex, FLAT, 0);
    await ex.apply(ctx, place('SELL', stopLimit('100', '95')));
    step(ex, { open: '101', low: '99', high: '101', ...volume }, 1);
    step(ex, { ...ABOVE_STOP, ...volume }, 2);
    expect(ex.getTrades().map((t) => [t.price, t.qty, t.feeQuote])).toEqual([
      ['100', '0.5', '0.1'],
      ['95', '0.5', '0.0475'],
    ]);
  });

  it('conserves base across a partial SELL', async () => {
    const ex = executor({ ...NO_SLIP, volumeCapPct: 50 });
    const volume = { volume: '1' };
    step(ex, FLAT, 0);
    await ex.apply(ctx, place('SELL', stopLimit('100', '95')));
    step(ex, { open: '101', low: '99', high: '101', ...volume }, 1);
    const btc = ex.snapshotAccount().balances['BTC'];
    expect([btc?.free.toString(), btc?.locked.toString()]).toEqual(['9', '0.5']);
  });

  it('conserves quote across a partial BUY', async () => {
    const ex = executor({ ...NO_SLIP, spreadBps: 20, volumeCapPct: 50 });
    const volume = { volume: '1' };
    step(ex, { open: '101', low: '100.5', high: '102', ...volume }, 0);
    await ex.apply(ctx, place('BUY', limit('100')));
    step(ex, { open: '100', low: '95', high: '101', ...volume }, 1);
    const usdt = ex.snapshotAccount().balances['USDT'];
    // The 0.5 filled at 100 cost 50.05 with maker fee, and the remainder locks 50 plus the 20 bps larger fee.
    expect([usdt?.free.toString(), usdt?.locked.toString()]).toEqual(['9899.85', '50.1']);
  });
});

describe('BUY reserves limit x qty plus larger fee, no spread uplift', () => {
  const reserve = (opts: OhlcvFillModelOptions, side: OrderSide, params: OrderParams) =>
    new OhlcvFillModel(opts).reserve({
      intent: { symbol: SYMBOL, side, reason: 'manual', clientOrderId: 'c1' },
      params,
      symbolInfo: SYMBOL_INFO,
    });

  it('lifts a BUY LIMIT by the taker fee when taker is the larger', () => {
    const out = reserve({ makerBps: 10, takerBps: 20, slippageBps: 0 }, 'BUY', limit('100'));
    expect(out).toMatchObject({ asset: 'USDT' });
    expect(out.amount.toString()).toBe('100.2');
  });

  it('lifts a BUY stop-limit by the maker fee when maker is the larger', () => {
    const out = reserve(
      { makerBps: 30, takerBps: 20, slippageBps: 0 },
      'BUY',
      stopLimit('99', '100'),
    );
    expect(out.amount.toString()).toBe('100.3');
  });

  it('adds nothing for the spread on a BUY LIMIT', () => {
    const out = reserve(
      { makerBps: 10, takerBps: 20, slippageBps: 0, spreadBps: 200 },
      'BUY',
      limit('100'),
    );
    expect(out.amount.toString()).toBe('100.2');
  });

  it('adds nothing for the spread on a BUY stop-limit', () => {
    const out = reserve(
      { makerBps: 10, takerBps: 20, slippageBps: 0, spreadBps: 200 },
      'BUY',
      stopLimit('99', '100'),
    );
    expect(out.amount.toString()).toBe('100.2');
  });

  it('still reserves only the base on a SELL', () => {
    const out = reserve(COSTS, 'SELL', limit('100'));
    expect([out.asset, out.amount.toString()]).toEqual(['BTC', '1']);
  });
});
