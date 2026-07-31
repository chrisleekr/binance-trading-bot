import { describe, expect, it } from 'vitest';
import { allowBuySet, forceSellTriggers, type TechnicalsIntervalConfig } from '../src/index.js';

const row = (over: Partial<TechnicalsIntervalConfig>): TechnicalsIntervalConfig =>
  ({
    interval: '1h',
    whenStrongBuy: false,
    whenBuy: false,
    whenSell: false,
    whenStrongSell: false,
    whenNeutral: false,
    mode: 'block',
    ...over,
  }) as TechnicalsIntervalConfig;

describe('allowBuySet', () => {
  it('includes only the armed buy recommendations', () => {
    expect([...allowBuySet(row({ whenStrongBuy: true, whenBuy: true }))].sort()).toEqual([
      'BUY',
      'STRONG_BUY',
    ]);
    expect([...allowBuySet(row({ whenBuy: true }))]).toEqual(['BUY']);
    expect([...allowBuySet(row({ whenStrongBuy: true }))]).toEqual(['STRONG_BUY']);
  });

  it('is empty when neither buy toggle is on (non-participating row)', () => {
    expect(allowBuySet(row({ whenSell: true })).size).toBe(0);
  });
});

describe('forceSellTriggers', () => {
  it('includes only the armed sell/neutral recommendations', () => {
    expect(
      [
        ...forceSellTriggers(row({ whenSell: true, whenStrongSell: true, whenNeutral: true })),
      ].sort(),
    ).toEqual(['NEUTRAL', 'SELL', 'STRONG_SELL']);
    expect([...forceSellTriggers(row({ whenSell: true }))]).toEqual(['SELL']);
  });

  it('is empty when no sell toggle is on', () => {
    expect(forceSellTriggers(row({ whenBuy: true })).size).toBe(0);
  });
});
