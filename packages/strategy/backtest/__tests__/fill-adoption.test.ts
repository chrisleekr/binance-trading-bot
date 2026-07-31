import { Decimal } from '@app/money';
import { describe, expect, it } from 'vitest';

import { adoptOne, runBacktest } from '../src/run.js';
import { IdealFillModel } from '../src/ideal-fill.js';
import {
  candleSource,
  flatCandles,
  makePositionStrategy,
  SYMBOL,
  SYMBOL_INFO,
} from './_fixtures.js';

const baseOpts = {
  request: { symbols: [SYMBOL], intervals: ['1m'] as const, fromMs: 0, toMs: 600_000 },
  initialBalances: { USDT: '1000' },
  quoteAsset: 'USDT',
  symbolInfos: [SYMBOL_INFO],
  config: {},
};

// The engine adopts executor fills into the plugin's position state (its
// analogue of the live fill-adopter). Without it, a strategy that reads its
// position from state — and writes the position only via the adapter, like
// TT — never learns it bought and re-buys every candle.
describe('runBacktest — fill adoption converges position state', () => {
  it('a position-managing strategy buys exactly once, not every candle', async () => {
    const report = await runBacktest({
      ...baseOpts,
      strategy: makePositionStrategy('0.01'),
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(10, '100')),
    });
    // 10 candles: tick 1 emits a buy, adoption sets avgEntryPrice, ticks 2..10
    // see the position and hold. Exactly one trade.
    expect(report.summary.tradeCount).toBe(1);
    expect(report.trades[0]).toMatchObject({ side: 'BUY', qty: '0.01', price: '100' });
  });
});

describe('adoptOne — fill-to-position math (mirrors the live fill-adopter)', () => {
  const position = makePositionStrategy('1').position;
  if (!position) throw new Error('position adapter expected on fixture strategy');
  const flat = { avgEntryPrice: null, heldQuantity: null };

  it('a first buy sets entry price and held quantity', () => {
    const after = adoptOne(position, flat, {
      symbol: SYMBOL,
      side: 'BUY',
      price: new Decimal('100'),
      qty: new Decimal('1'),
    });
    expect(after).toEqual({ avgEntryPrice: '100', heldQuantity: '1' });
  });

  it('a second buy adds at the weighted-average entry price', () => {
    // 1@100 then 1@200 → avg 150, qty 2.
    const after1 = adoptOne(position, flat, {
      symbol: SYMBOL,
      side: 'BUY',
      price: new Decimal('100'),
      qty: new Decimal('1'),
    });
    const after2 = adoptOne(position, after1, {
      symbol: SYMBOL,
      side: 'BUY',
      price: new Decimal('200'),
      qty: new Decimal('1'),
    });
    expect(after2).toEqual({ avgEntryPrice: '150', heldQuantity: '2' });
  });

  it('a partial sell reduces held quantity, keeping the entry price', () => {
    const held = { avgEntryPrice: '150', heldQuantity: '2' };
    const after = adoptOne(position, held, {
      symbol: SYMBOL,
      side: 'SELL',
      price: new Decimal('160'),
      qty: new Decimal('0.5'),
    });
    expect(after).toEqual({ avgEntryPrice: '150', heldQuantity: '1.5' });
  });

  it('a sell that empties the position flattens it', () => {
    const held = { avgEntryPrice: '150', heldQuantity: '2' };
    const after = adoptOne(position, held, {
      symbol: SYMBOL,
      side: 'SELL',
      price: new Decimal('160'),
      qty: new Decimal('2'),
    });
    expect(after).toEqual({ avgEntryPrice: null, heldQuantity: null });
  });

  it('a sell with no tracked position flattens rather than going negative', () => {
    const after = adoptOne(position, flat, {
      symbol: SYMBOL,
      side: 'SELL',
      price: new Decimal('160'),
      qty: new Decimal('1'),
    });
    expect(after).toEqual({ avgEntryPrice: null, heldQuantity: null });
  });

  it('folds two sequential buy fills (re-rest / partial completion) to the weighted average', () => {
    // A partial that later completes adopts as two fills; the entry price must
    // land on the same weighted average as a single combined fill.
    const after1 = adoptOne(position, flat, {
      symbol: SYMBOL,
      side: 'BUY',
      price: new Decimal('100'),
      qty: new Decimal('0.5'),
    });
    const after2 = adoptOne(position, after1, {
      symbol: SYMBOL,
      side: 'BUY',
      price: new Decimal('120'),
      qty: new Decimal('1.5'),
    });
    // (100*0.5 + 120*1.5) / 2 = 115, qty 2.
    expect(after2).toEqual({ avgEntryPrice: '115', heldQuantity: '2' });
  });
});
