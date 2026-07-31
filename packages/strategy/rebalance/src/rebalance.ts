import { Decimal } from '@app/money';

/** A rebalance verdict for one symbol: publish its value, and maybe trade. */
export interface RebalancePlan {
  /** This symbol's mark-to-market value to publish to the KV store (always). */
  readonly ownValueQuote: string;
  /** The trade to move toward target, or null to hold. */
  readonly trade: { readonly side: 'BUY' | 'SELL'; readonly quantity: string } | null;
  /** Why — for the audit metric. */
  readonly reason:
    | 'disabled'
    | 'no-target'
    | 'no-basket-value'
    | 'within-drift'
    | 'below-min-trade'
    | 'no-quote'
    | 'below-step'
    | 'rotate-exit'
    | 'rebalance';
}

export interface RebalanceInput {
  readonly currentPrice: Decimal;
  readonly heldQty: Decimal;
  /** This symbol's target weight (0 when not in the basket). */
  readonly targetWeight: Decimal;
  /** Sibling symbols' values (quote) from the KV snapshot; excludes self. */
  readonly siblingValuesQuote: readonly Decimal[];
  readonly driftThreshold: Decimal;
  readonly minTradeQuote: Decimal;
  /**
   * Total quote to allocate to the basket. Free cash is counted toward the
   * basket value only up to this budget's remaining headroom, so the strategy
   * buys in from cash on a flat start and then holds the weights — without ever
   * reaching for more than the budget of the shared account's cash. 0 disables
   * deployment (maintain an existing basket only).
   */
  readonly basketBudgetQuote: Decimal;
  /** Free quote cash available to fund a buy. */
  readonly availableQuote: Decimal;
  /** Step size for the base quantity; a trade is floored to a multiple of it. */
  readonly stepSize: Decimal;
  readonly enabled: boolean;
  /**
   * When the target weight is 0 AND the symbol is still held, sell the whole
   * position (rotate to cash) instead of holding. Off by default so fixed-weight
   * baskets leave non-target holdings alone; momentum mode turns it on so a symbol
   * that falls out of the top-K is liquidated.
   */
  readonly exitWhenZeroWeight?: boolean;
}

/** Floor `qty` to a whole multiple of `step` (Binance LOT_SIZE). step<=0 → qty. */
const floorToStep = (qty: Decimal, step: Decimal): Decimal =>
  step.lte(0) ? qty : qty.div(step).floor().mul(step);

/**
 * Decide one symbol's rebalance. Pure Decimal math. The strategy holds a
 * fixed-weight basket; when this symbol's share of the basket drifts past the
 * threshold it trades back toward target — selling what rose, buying what fell
 * (the rebalancing premium). Sizing:
 *   basketValue = ownValue + Σ siblingValues
 *   deployable  = min(freeCash, max(0, basketBudgetQuote − basketValue))
 *   total       = basketValue + deployable
 *   targetVal   = targetWeight × total
 *   delta       = targetVal − ownValue   (>0 underweight → buy, <0 overweight → sell)
 * Counting only the budget's unfilled headroom as deployable cash makes a flat
 * basket buy in from cash, then collapses to constant-weight maintenance once
 * the budget is deployed (headroom → 0), and never spends past the budget. A buy
 * is capped by free quote; a sell is capped by the held quantity. Trades below
 * `minTradeQuote` or that floor to zero base are held (no dust churn).
 */
export const computeRebalance = (input: RebalanceInput): RebalancePlan => {
  const ownValue = input.currentPrice.mul(input.heldQty);
  const ownValueQuote = ownValue.toString();
  const hold = (reason: RebalancePlan['reason']): RebalancePlan => ({
    ownValueQuote,
    trade: null,
    reason,
  });

  if (!input.enabled) return hold('disabled');
  if (input.targetWeight.lte(0)) {
    // Rotate-to-cash: a momentum symbol that fell out of the top-K is sold whole.
    if (input.exitWhenZeroWeight === true && input.heldQty.gt(0)) {
      if (ownValue.lt(input.minTradeQuote)) return hold('below-min-trade');
      const qty = floorToStep(input.heldQty, input.stepSize);
      if (qty.lte(0)) return hold('below-step');
      return {
        ownValueQuote,
        trade: { side: 'SELL', quantity: qty.toString() },
        reason: 'rotate-exit',
      };
    }
    return hold('no-target');
  }

  let basketValue = ownValue;
  for (const v of input.siblingValuesQuote) basketValue = basketValue.add(v);
  // Cash counts toward the basket only up to the budget's unfilled headroom, so
  // deployment is bounded and self-limiting as holdings fill the budget.
  const headroom = Decimal.max(new Decimal(0), input.basketBudgetQuote.sub(basketValue));
  const deployable = Decimal.min(input.availableQuote, headroom);
  const total = basketValue.add(deployable);
  if (total.lte(0) || input.currentPrice.lte(0)) return hold('no-basket-value');

  const currentWeight = ownValue.div(total);
  const drift = currentWeight.sub(input.targetWeight).abs();
  if (drift.lt(input.driftThreshold)) return hold('within-drift');

  const targetValue = input.targetWeight.mul(total);
  const delta = targetValue.sub(ownValue); // >0 buy, <0 sell

  if (delta.gt(0)) {
    const notional = Decimal.min(delta, input.availableQuote);
    if (notional.lt(input.minTradeQuote)) {
      // Distinguish "no cash" from "trade too small" for the audit trail.
      return hold(input.availableQuote.lt(input.minTradeQuote) ? 'no-quote' : 'below-min-trade');
    }
    const qty = floorToStep(notional.div(input.currentPrice), input.stepSize);
    if (qty.lte(0)) return hold('below-step');
    return { ownValueQuote, trade: { side: 'BUY', quantity: qty.toString() }, reason: 'rebalance' };
  }

  // Sell the overweight excess, capped by what is actually held.
  const sellNotional = delta.abs();
  if (sellNotional.lt(input.minTradeQuote)) return hold('below-min-trade');
  const wantQty = sellNotional.div(input.currentPrice);
  const qty = floorToStep(Decimal.min(wantQty, input.heldQty), input.stepSize);
  if (qty.lte(0)) return hold('below-step');
  return { ownValueQuote, trade: { side: 'SELL', quantity: qty.toString() }, reason: 'rebalance' };
};
