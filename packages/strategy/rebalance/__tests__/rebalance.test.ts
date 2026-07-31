import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { computeRebalance, type RebalanceInput } from '../src/rebalance.js';

const D = (v: string | number) => new Decimal(v);

const base = (over: Partial<RebalanceInput> = {}): RebalanceInput => ({
  currentPrice: D(100),
  heldQty: D(5), // ownValue = 500
  targetWeight: D('0.5'),
  siblingValuesQuote: [D(500)], // total = 1000, currentWeight = 0.5
  driftThreshold: D('0.05'),
  minTradeQuote: D(10),
  basketBudgetQuote: D(0), // maintain-only by default; deployment tests opt in
  availableQuote: D(10_000),
  stepSize: D('0.001'),
  enabled: true,
  ...over,
});

describe('computeRebalance', () => {
  it('always reports own value; holds when disabled', () => {
    const r = computeRebalance(base({ enabled: false }));
    expect(r.ownValueQuote).toBe('500');
    expect(r.trade).toBeNull();
    expect(r.reason).toBe('disabled');
  });

  it('holds when the symbol is not in the basket (target 0)', () => {
    expect(computeRebalance(base({ targetWeight: D(0) })).reason).toBe('no-target');
  });

  it('rotates a held position to cash when target 0 and exitWhenZeroWeight is on', () => {
    const r = computeRebalance(base({ targetWeight: D(0), exitWhenZeroWeight: true }));
    expect(r.reason).toBe('rotate-exit');
    expect(r.trade).toEqual({ side: 'SELL', quantity: '5' }); // whole 5 held, floored to step
  });

  it('does not rotate when target 0, exitWhenZeroWeight on, but nothing is held', () => {
    const r = computeRebalance(
      base({ targetWeight: D(0), heldQty: D(0), exitWhenZeroWeight: true }),
    );
    expect(r.reason).toBe('no-target');
  });

  it('skips a rotate-exit below the min trade (dust)', () => {
    // ownValue = 1 × 5 = 5 < minTradeQuote 10.
    const r = computeRebalance(
      base({ targetWeight: D(0), currentPrice: D(1), exitWhenZeroWeight: true }),
    );
    expect(r.reason).toBe('below-min-trade');
  });

  it('skips a rotate-exit that floors to zero base (step larger than the position)', () => {
    const r = computeRebalance(
      base({ targetWeight: D(0), stepSize: D(10), exitWhenZeroWeight: true }),
    );
    expect(r.reason).toBe('below-step');
  });

  it('holds when the basket has no value (total 0)', () => {
    expect(computeRebalance(base({ heldQty: D(0), siblingValuesQuote: [] })).reason).toBe(
      'no-basket-value',
    );
  });

  it('holds when the price is non-positive (avoids divide-by-zero)', () => {
    expect(computeRebalance(base({ currentPrice: D(0), heldQty: D(0) })).reason).toBe(
      'no-basket-value',
    );
  });

  it('holds when the weight is within the drift threshold', () => {
    // at target exactly (0.5 vs 0.5) → drift 0 < 0.05
    expect(computeRebalance(base()).reason).toBe('within-drift');
  });

  it('BUYS the underweight shortfall, floored to the step', () => {
    // ownValue 100 (1@100), siblings 900 → total 1000, weight 0.1, target 0.5.
    // delta = 0.5*1000 - 100 = 400 → qty 4.
    const r = computeRebalance(base({ heldQty: D(1), siblingValuesQuote: [D(900)] }));
    expect(r.reason).toBe('rebalance');
    expect(r.trade).toEqual({ side: 'BUY', quantity: '4' });
  });

  it('caps a BUY at the available quote cash', () => {
    const r = computeRebalance(
      base({ heldQty: D(1), siblingValuesQuote: [D(900)], availableQuote: D(150) }),
    );
    // notional capped at 150 → qty 1.5
    expect(r.trade).toEqual({ side: 'BUY', quantity: '1.5' });
  });

  it('holds an underweight buy when no quote cash is free', () => {
    const r = computeRebalance(
      base({ heldQty: D(1), siblingValuesQuote: [D(900)], availableQuote: D(0) }),
    );
    expect(r.reason).toBe('no-quote');
  });

  it('holds an underweight buy whose notional is below the dust floor', () => {
    // delta tiny: weight 0.49 vs 0.5 but past drift? use drift 0.005 to pass drift, tiny delta.
    const r = computeRebalance(
      base({
        heldQty: D('4.9'),
        siblingValuesQuote: [D('505')],
        driftThreshold: D('0.001'),
        minTradeQuote: D(50),
      }),
    );
    // ownValue 490, total 995, weight ~0.4925, target 0.5 → delta ~7.4 < 50
    expect(r.reason).toBe('below-min-trade');
  });

  it('holds a buy that floors to zero base (step larger than the qty)', () => {
    const r = computeRebalance(
      base({ heldQty: D(1), siblingValuesQuote: [D(900)], stepSize: D(100) }),
    );
    expect(r.reason).toBe('below-step');
  });

  it('SELLS the overweight excess, capped by the held quantity', () => {
    // ownValue 900 (9@100), siblings 100 → total 1000, weight 0.9, target 0.5.
    // delta = 500 - 900 = -400 → sell 4.
    const r = computeRebalance(base({ heldQty: D(9), siblingValuesQuote: [D(100)] }));
    expect(r.trade).toEqual({ side: 'SELL', quantity: '4' });
  });

  it('holds an overweight sell below the dust floor', () => {
    const r = computeRebalance(
      base({
        heldQty: D('5.1'),
        siblingValuesQuote: [D('495')],
        driftThreshold: D('0.001'),
        minTradeQuote: D(50),
      }),
    );
    expect(r.reason).toBe('below-min-trade');
  });

  it('holds a sell that floors to zero base', () => {
    const r = computeRebalance(
      base({ heldQty: D(9), siblingValuesQuote: [D(100)], stepSize: D(100) }),
    );
    expect(r.reason).toBe('below-step');
  });

  it('does not floor when stepSize is non-positive', () => {
    const r = computeRebalance(
      base({ heldQty: D(1), siblingValuesQuote: [D(900)], stepSize: D(0) }),
    );
    expect(r.trade).toEqual({ side: 'BUY', quantity: '4' });
  });

  it('buys into a flat basket from cash up to the budget', () => {
    // Flat (own 0, no siblings) with a budget: deployable = min(cash, budget) =
    // 1000, total = 1000, targetValue = 0.5 * 1000 = 500 → buy 5 @ 100.
    const r = computeRebalance(
      base({
        heldQty: D(0),
        siblingValuesQuote: [],
        basketBudgetQuote: D(1000),
        availableQuote: D(10_000),
      }),
    );
    expect(r.trade).toEqual({ side: 'BUY', quantity: '5' });
    expect(r.reason).toBe('rebalance');
  });

  it('caps deployment at the budget, not the free cash', () => {
    // Free cash 10k but budget 1000: headroom caps deployable at 1000, so the
    // buy targets 500 (qty 5), never the 5000 the cash alone would fund.
    const r = computeRebalance(
      base({
        heldQty: D(0),
        siblingValuesQuote: [],
        basketBudgetQuote: D(1000),
        availableQuote: D(10_000),
      }),
    );
    expect(r.trade?.quantity).toBe('5');
  });

  it('deploys only the cash on hand when it is below the budget headroom', () => {
    // Budget 1000 but only 200 cash: deployable = 200, total = 200, targetValue
    // = 100 → buy 1 @ 100.
    const r = computeRebalance(
      base({
        heldQty: D(0),
        siblingValuesQuote: [],
        basketBudgetQuote: D(1000),
        availableQuote: D(200),
      }),
    );
    expect(r.trade).toEqual({ side: 'BUY', quantity: '1' });
  });

  it('stops deploying once holdings fill the budget, holding within drift', () => {
    // basketValue 1000 already meets the 1000 budget: headroom 0, deployable 0,
    // total = basketValue, so a balanced basket just holds (no cash spent).
    const r = computeRebalance(base({ basketBudgetQuote: D(1000) }));
    expect(r.reason).toBe('within-drift');
    expect(r.trade).toBeNull();
  });

  it('holds a flat basket when the budget is zero (maintain-only)', () => {
    // Default budget 0: nothing held and no cash counted → total 0 → no trade.
    const r = computeRebalance(base({ heldQty: D(0), siblingValuesQuote: [] }));
    expect(r.reason).toBe('no-basket-value');
  });

  it('keeps total first-candle deployment within the budget across the basket', () => {
    // The over-deployment guard: three flat symbols, each seeing siblings as
    // stale-zero (first candle, nothing published yet) and the full shared cash.
    // With weights summing to 1, each buys only its slice, so the basket's total
    // spend equals the budget, not weights×cash. price 100, budget 1000.
    const weights = ['0.5', '0.3', '0.2'];
    const notional = weights
      .map((w) =>
        computeRebalance(
          base({
            heldQty: D(0),
            siblingValuesQuote: [D(0), D(0)],
            targetWeight: D(w),
            basketBudgetQuote: D(1000),
            availableQuote: D(10_000),
          }),
        ),
      )
      .reduce((sum, plan) => sum.add(D(plan.trade?.quantity ?? '0').mul(100)), D(0));
    expect(notional.lte(1000)).toBe(true);
    expect(notional.toString()).toBe('1000');
  });
});
