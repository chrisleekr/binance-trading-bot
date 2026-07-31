import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';

import { momentumScore, momentumTargetWeight } from '../src/momentum.js';

const candles = (...closes: string[]): { close: string }[] => closes.map((close) => ({ close }));

describe('momentumScore', () => {
  it('is the trailing return over the lookback', () => {
    // last 121 / close 2 candles ago 100 − 1 = 0.21.
    expect(momentumScore(candles('100', '110', '121'), 2)?.toString()).toBe('0.21');
  });

  it('is null when the window is too short to span the lookback', () => {
    expect(momentumScore(candles('100', '110'), 2)).toBeNull();
  });

  it('is null when the past close is non-positive', () => {
    expect(momentumScore(candles('0', '1', '2'), 2)).toBeNull();
  });

  it('is null when the latest close is non-positive', () => {
    expect(momentumScore(candles('1', '1', '0'), 2)).toBeNull();
  });

  it('is null when a close is unparseable', () => {
    expect(momentumScore(candles('x', '1', '2'), 2)).toBeNull();
  });
});

const entry = (symbol: string, score: string) => ({ symbol, score: new Decimal(score) });

describe('momentumTargetWeight', () => {
  it('gives self an equal share when it ranks in the top-K', () => {
    const w = momentumTargetWeight(
      entry('AAA', '0.3'),
      [entry('BBB', '0.1'), entry('CCC', '0.2')],
      2,
    );
    expect(w.toString()).toBe('0.5'); // top-2 of 3 → 1/2
  });

  it('gives self zero when it ranks below the top-K (rotate to cash)', () => {
    const w = momentumTargetWeight(
      entry('AAA', '0.05'),
      [entry('BBB', '0.1'), entry('CCC', '0.2')],
      2,
    );
    expect(w.toString()).toBe('0');
  });

  it('equal-weights everyone when fewer symbols than K exist', () => {
    const w = momentumTargetWeight(entry('AAA', '0.3'), [entry('BBB', '0.1')], 5);
    expect(w.toString()).toBe('0.5'); // min(5,2) = 2 held → 1/2
  });

  it('breaks score ties by symbol ascending so every tick agrees on the order', () => {
    // AAA and BBB tie at 0.1, topK=1. AAA sorts first → holds 1/1; BBB → 0.
    expect(momentumTargetWeight(entry('AAA', '0.1'), [entry('BBB', '0.1')], 1).toString()).toBe(
      '1',
    );
    expect(momentumTargetWeight(entry('BBB', '0.1'), [entry('AAA', '0.1')], 1).toString()).toBe(
      '0',
    );
  });
});
