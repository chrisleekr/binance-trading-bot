import { describe, expect, it } from 'vitest';

import {
  avgLoss,
  avgWin,
  expectancy,
  formatExpectancy,
  payoffRatio,
  profitFactor,
  type RollupStatsBucket,
  winPct,
} from '@/shared/lib/rollup-stats';

/** Bucket with sensible defaults; override only what a case exercises. */
function bucket(p: Partial<RollupStatsBucket> = {}): RollupStatsBucket {
  return {
    tradeCount: 0,
    wins: 0,
    losses: 0,
    grossProfit: '0',
    grossLoss: '0',
    totalFees: '0',
    ...p,
  };
}

describe('rollup-stats trader metrics', () => {
  it('winPct rounds wins / trades to a whole percent; 0 trades is 0', () => {
    expect(winPct(bucket({ tradeCount: 4, wins: 1 }))).toBe(25);
    expect(winPct(bucket({ tradeCount: 0 }))).toBe(0);
  });

  it('avgWin / avgLoss divide gross magnitudes by their counts, null when none', () => {
    expect(avgWin(bucket({ wins: 2, grossProfit: '10' }))).toBe(5);
    expect(avgWin(bucket({ wins: 0, grossProfit: '0' }))).toBeNull();
    expect(avgLoss(bucket({ losses: 4, grossLoss: '8' }))).toBe(2);
    expect(avgLoss(bucket({ losses: 0 }))).toBeNull();
  });

  it('expectancy is net profit per trade (grossProfit − grossLoss) / trades', () => {
    // 3 trades, +12 winners, −6 losers → net 6 over 3 = +2/trade.
    expect(expectancy(bucket({ tradeCount: 3, grossProfit: '12', grossLoss: '6' }))).toBe(2);
    // A negative-edge bucket reads negative.
    expect(expectancy(bucket({ tradeCount: 2, grossProfit: '1', grossLoss: '5' }))).toBe(-2);
    expect(expectancy(bucket({ tradeCount: 0 }))).toBeNull();
  });

  it('payoffRatio is avgWin / avgLoss, null when a side is empty', () => {
    expect(payoffRatio(bucket({ wins: 1, losses: 1, grossProfit: '6', grossLoss: '3' }))).toBe(2);
    expect(payoffRatio(bucket({ wins: 1, losses: 0, grossProfit: '6' }))).toBeNull();
  });

  it('profitFactor: 0 when no winners, null (∞) when no losers, else the ratio', () => {
    expect(profitFactor(bucket({ grossProfit: '0', grossLoss: '5' }))).toBe(0);
    expect(profitFactor(bucket({ grossProfit: '5', grossLoss: '0' }))).toBeNull();
    expect(profitFactor(bucket({ grossProfit: '6', grossLoss: '3' }))).toBe(2);
  });

  it('formatExpectancy: U+2212 minus for negatives, 2 sig-figs sub-1, 2 decimals else', () => {
    expect(formatExpectancy(-0.5)).toBe('−0.50'); // negative → U+2212, sub-1 → 2 sig-figs
    expect(formatExpectancy(0.0033)).toBe('+0.0033'); // small edge keeps 2 sig-figs, not 0
    expect(formatExpectancy(12.5)).toBe('+12.50'); // >= 1 → 2 decimals
    expect(formatExpectancy(0)).toBe('+0.0'); // zero is non-negative → '+'
  });
});
