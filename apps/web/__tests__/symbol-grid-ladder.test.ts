// buyLadderFromStrategy — the configured buy-grid ladder rows: trigger and
// per-rung max purchase amount (budget), with `reached` derived from the
// live currentGridTradeIndex.

import { describe, expect, it } from 'vitest';

import type { SymbolStateResponse } from '@app/contracts';

import {
  buyLadderFromStrategy,
  levelBudget,
  projectGridLadder,
} from '../src/features/symbol/strategies/trailing-trade/grid-ladder.js';

/** Minimal SymbolStateResponse — `config`/`state` are opaque, so plain objects suffice. */
const makeState = (opts: {
  levels?: unknown;
  currentGridTradeIndex?: unknown;
}): SymbolStateResponse =>
  ({
    strategy: {
      name: 'trailing-trade',
      config: { buy: { gridLevels: opts.levels } },
      state: { currentGridTradeIndex: opts.currentGridTradeIndex },
    },
    avgEntryPrice: null,
    openOrders: [],
    disable: null,
  }) as unknown as SymbolStateResponse;

const LEVELS = [
  { triggerPercentage: '1', maxPurchaseAmount: '15' },
  { triggerPercentage: '0.97', maxPurchaseAmount: '30' },
  { triggerPercentage: '0.94', maxPurchaseAmount: '60' },
];

describe('buyLadderFromStrategy', () => {
  it('returns null when no grid is configured', () => {
    expect(buyLadderFromStrategy(makeState({ currentGridTradeIndex: null }).strategy)).toBeNull();
    expect(
      buyLadderFromStrategy(makeState({ levels: [], currentGridTradeIndex: null }).strategy),
    ).toBeNull();
  });

  it('carries trigger and max purchase amount for every rung', () => {
    const ladder = buyLadderFromStrategy(
      makeState({ levels: LEVELS, currentGridTradeIndex: null }).strategy,
    );
    expect(ladder).toEqual([
      { triggerPercentage: '1', maxPurchaseAmount: '15', reached: false },
      { triggerPercentage: '0.97', maxPurchaseAmount: '30', reached: false },
      { triggerPercentage: '0.94', maxPurchaseAmount: '60', reached: false },
    ]);
  });

  it('marks rungs at or below currentGridTradeIndex as reached', () => {
    const ladder = buyLadderFromStrategy(
      makeState({ levels: LEVELS, currentGridTradeIndex: 1 }).strategy,
    );
    expect(ladder?.map((r) => r.reached)).toEqual([true, true, false]);
  });

  it('leaves a missing or wrong-typed field undefined rather than throwing', () => {
    const ladder = buyLadderFromStrategy(
      makeState({
        levels: [{ triggerPercentage: '1' }, { maxPurchaseAmount: { nested: true } }],
        currentGridTradeIndex: null,
      }).strategy,
    );
    expect(ladder?.[0]).toEqual({
      triggerPercentage: '1',
      maxPurchaseAmount: undefined,
      reached: false,
    });
    expect(ladder?.[1]?.maxPurchaseAmount).toBeUndefined();
  });
});

describe('levelBudget', () => {
  it('resolves the spent quote as the level max purchase amount', () => {
    expect(levelBudget({ maxPurchaseAmount: '15' })).toBe('15');
    expect(levelBudget({ maxPurchaseAmount: '30' })).toBe('30');
    expect(levelBudget({ maxPurchaseAmount: '20' })).toBe('20');
  });

  it('returns a dash for absent, non-numeric, blank, zero, or negative inputs', () => {
    expect(levelBudget({})).toBe('—');
    expect(levelBudget({ maxPurchaseAmount: 'abc' })).toBe('—');
    // '' and '  ' coerce to 0 through Number() — must not render `spend 0`.
    expect(levelBudget({ maxPurchaseAmount: '' })).toBe('—');
    expect(levelBudget({ maxPurchaseAmount: '  ' })).toBe('—');
    // zero / negative — a rung the executor would skip; not a real spend.
    expect(levelBudget({ maxPurchaseAmount: '0' })).toBe('—');
    expect(levelBudget({ maxPurchaseAmount: '-1' })).toBe('—');
  });
});

describe('projectGridLadder', () => {
  const LEVELS = [
    { triggerPercentage: '1', maxPurchaseAmount: '100' },
    { triggerPercentage: '0.9', maxPurchaseAmount: '100' },
    { triggerPercentage: '0.8', maxPurchaseAmount: '200' },
  ];

  it('returns [] for a non-positive or non-finite entry price', () => {
    expect(projectGridLadder(LEVELS, 0)).toEqual([]);
    expect(projectGridLadder(LEVELS, -1000)).toEqual([]);
    expect(projectGridLadder(LEVELS, Number.NaN)).toEqual([]);
  });

  it('projects fill price, spend, and cumulative position per rung', () => {
    const rows = projectGridLadder(LEVELS, 1000);
    expect(rows.map((r) => r.fillPrice)).toEqual([1000, 900, 720]);
    // quote = the rung's max purchase amount; rung 2 spends twice rung 0.
    expect(rows.map((r) => r.quoteSpent)).toEqual([100, 100, 200]);
    expect(rows.map((r) => r.cumQuote)).toEqual([100, 200, 400]);
    // rung 0: base 100/1000 = 0.1; rung 1: 100/900; rung 2: 200/720.
    expect(rows[1]?.baseQty).toBeCloseTo(100 / 900, 9);
    expect(rows[2]?.cumBase).toBeCloseTo(0.1 + 100 / 900 + 200 / 720, 9);
    // average cost = cumQuote / cumBase.
    expect(rows[2]?.avgCost).toBeCloseTo(400 / (0.1 + 100 / 900 + 200 / 720), 6);
  });

  it('returns [] when a level field is absent or non-positive', () => {
    expect(projectGridLadder([{}], 1000)).toEqual([]);
    expect(projectGridLadder([{ maxPurchaseAmount: '0' }], 1000)).toEqual([]);
    // a promotion rung needs a positive triggerPercentage.
    expect(
      projectGridLadder(
        [{ triggerPercentage: '1', maxPurchaseAmount: '100' }, { maxPurchaseAmount: '100' }],
        1000,
      ),
    ).toEqual([]);
  });
});
