import { describe, expect, it } from 'vitest';

import { groupingSteps, groupLevels } from '../src/features/symbol/lib/order-book-group.js';

import { asDecimalString, type OrderBook, type OrderBookLevel } from '@app/contracts';

const lvl = (price: string, qty: string): OrderBookLevel => ({
  price: asDecimalString(price),
  qty: asDecimalString(qty),
});

describe('groupLevels', () => {
  it('returns levels unchanged when step is zero or negative', () => {
    const levels = [lvl('100.01', '1'), lvl('100.02', '2')];
    expect(groupLevels(levels, 'ask', 0)).toEqual(levels);
    expect(groupLevels(levels, 'bid', -1)).toEqual(levels);
  });

  it('rounds asks up to the bucket ceiling and sums quantity', () => {
    // 100.01 and 100.02 both round up to the 100.10 bucket; 100.15 to 100.20.
    const grouped = groupLevels(
      [lvl('100.01', '1'), lvl('100.02', '2'), lvl('100.15', '4')],
      'ask',
      0.1,
    );
    expect(grouped).toEqual([
      { price: '100.1', qty: '3' },
      { price: '100.2', qty: '4' },
    ]);
  });

  it('rounds bids down to the bucket floor and sums quantity', () => {
    // 100.09 and 100.01 both floor to the 100 bucket; 99.95 to 99.9.
    const grouped = groupLevels(
      [lvl('100.09', '1'), lvl('100.01', '2'), lvl('99.95', '5')],
      'bid',
      0.1,
    );
    expect(grouped).toEqual([
      { price: '100', qty: '3' },
      { price: '99.9', qty: '5' },
    ]);
  });

  it('returns an empty array for an empty side', () => {
    expect(groupLevels([], 'ask', 1)).toEqual([]);
  });

  it('keeps a level that sits exactly on a bucket edge in its own bucket', () => {
    // 100.00 / 0.1 = 1000 exactly; float dust must not push the ask up to
    // the 100.1 bucket. 100.05 genuinely ceils up to 100.1.
    expect(groupLevels([lvl('100.00', '1'), lvl('100.05', '2')], 'ask', 0.1)).toEqual([
      { price: '100', qty: '1' },
      { price: '100.1', qty: '2' },
    ]);
  });

  it('preserves best-first bucket order', () => {
    const grouped = groupLevels([lvl('100', '1'), lvl('110', '1'), lvl('120', '1')], 'ask', 100);
    // 100 ceils to its own 100 bucket; 110 and 120 ceil up to 200.
    expect(grouped).toEqual([
      { price: '100', qty: '1' },
      { price: '200', qty: '2' },
    ]);
  });
});

describe('groupingSteps', () => {
  const book = (asks: [string, string][], bids: [string, string][]): OrderBook => ({
    asks: asks.map(([p, q]) => lvl(p, q)),
    bids: bids.map(([p, q]) => lvl(p, q)),
  });

  it('derives four power-of-ten steps from the natural tick', () => {
    const steps = groupingSteps(
      book(
        [
          ['100.00', '1'],
          ['100.01', '1'],
          ['100.02', '1'],
        ],
        [
          ['99.99', '1'],
          ['99.98', '1'],
        ],
      ),
    );
    expect(steps).toEqual([0.01, 0.1, 1, 10]);
  });

  it('falls back to a mid-price-derived tick for a book too thin to measure', () => {
    const steps = groupingSteps(book([['1000', '1']], [['999', '1']]));
    // One level per side ⇒ no measurable gap; mid ~999.5 ⇒ tick
    // 10 ** (floor(log10(999.5)) - 5) = 10 ** -3.
    expect(steps).toEqual([0.001, 0.01, 0.1, 1]);
  });

  it('keeps a non-power-of-ten tick as the finest step', () => {
    // A 0.5 tick must survive — a power-of-ten snap would coarsen it to 1.
    const steps = groupingSteps(
      book(
        [
          ['100.0', '1'],
          ['100.5', '1'],
          ['101.0', '1'],
        ],
        [
          ['99.5', '1'],
          ['99.0', '1'],
        ],
      ),
    );
    expect(steps).toEqual([0.5, 5, 50, 500]);
  });

  it('does not throw on a fully empty book', () => {
    expect(groupingSteps(book([], []))).toHaveLength(4);
  });
});
