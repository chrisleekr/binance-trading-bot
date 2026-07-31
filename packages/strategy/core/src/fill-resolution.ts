import { Decimal } from '@app/money';

import type { AdoptedFill, PositionView } from './contract.js';

/**
 * One raw exchange fill, normalised to Decimal. `price` is the order VWAP
 * (cumQuoteQty/cumQty, live) or the single fill price (backtest); either is
 * valid because folding sub-fills one at a time yields the same weighted
 * average as folding their pre-combined VWAP once. `quantity` is the filled
 * amount on BUY, the sold amount on SELL. SELL ignores `price`.
 */
export interface RawFill {
  readonly side: 'BUY' | 'SELL';
  readonly price: Decimal;
  readonly quantity: Decimal;
}

type BuyAdoption = Extract<AdoptedFill, { kind: 'buy' }>;
type SellAdoption = Extract<AdoptedFill, { kind: 'sell-reduce' | 'empty' }>;

export function resolveFill(
  prior: PositionView | null,
  fill: RawFill & { side: 'BUY' },
): BuyAdoption;
export function resolveFill(
  prior: PositionView | null,
  fill: RawFill & { side: 'SELL' },
  stepSize?: Decimal,
): SellAdoption;
export function resolveFill(
  prior: PositionView | null,
  fill: RawFill,
  stepSize?: Decimal,
): AdoptedFill;
/**
 * Fold one raw fill onto a prior position view, producing the {@link AdoptedFill}
 * the caller hands to `PositionStateAdapter.applyFill`. BUY accumulates a
 * weighted-average entry price and held quantity; SELL reduces the held
 * quantity, flattening to `empty` once it reaches zero. `prior` is null for a
 * fresh position. This is the single source for the fold; the live executor and
 * the backtest engine both call it so their position math cannot drift.
 *
 * `stepSize` (the symbol's LOT_SIZE increment, live path only) flattens a SELL
 * whose residual is below it: a remainder smaller than the smallest tradeable
 * increment can never be sold, so the position IS flat. This clears the
 * phantom-position left when a base-asset trading fee makes a full exit's sold
 * quantity fall a fee's-worth short of the tracked (gross) held quantity —
 * otherwise `avgEntryPrice` lingers and blocks re-entry. Omitted (backtest,
 * existing fixtures) ⇒ the historical `lte(0)`-only behavior, so replay is
 * byte-identical.
 *
 * The flattened crumb's cost basis is intentionally NOT booked as realised P/L:
 * `realizedPnlOnSell` matches only the sold quantity, so a residual below one
 * step (unsellable dust, economically below the symbol's minimum tradeable
 * increment) is written off silently rather than recorded as a sub-cent loss.
 */
export function resolveFill(
  prior: PositionView | null,
  fill: RawFill,
  stepSize?: Decimal,
): AdoptedFill {
  const prevQty = prior?.heldQuantity ? new Decimal(prior.heldQuantity) : new Decimal(0);
  const prevLbp = prior?.avgEntryPrice ? new Decimal(prior.avgEntryPrice) : null;

  if (fill.side === 'BUY') {
    const nextQty = prevQty.plus(fill.quantity);
    // prevQty=0 collapses the weighted average to the fill price, so the
    // explicit guard and the general formula agree on a fresh/zeroed position.
    const nextLbp =
      prevLbp && prevQty.gt(0)
        ? prevLbp.times(prevQty).plus(fill.price.times(fill.quantity)).div(nextQty)
        : fill.price;
    return { kind: 'buy', avgEntryPrice: nextLbp.toString(), heldQuantity: nextQty.toString() };
  }

  const remaining = prevQty.minus(fill.quantity);
  // A residual strictly below one LOT_SIZE step is unsellable on the exchange,
  // so the position is effectively flat — flatten it rather than stranding it.
  const flat = remaining.lte(0) || (stepSize !== undefined && remaining.lt(stepSize));
  return flat ? { kind: 'empty' } : { kind: 'sell-reduce', heldQuantity: remaining.toString() };
}

/** Cost-basis-matched realised P/L for one SELL fill (decimal-strings). */
export interface RealizedPnl {
  /** matchedProceeds − costBasisQuote. */
  readonly realizedPnl: string;
  /** matchedQty × avgEntryPrice — the cost removed from the position. */
  readonly costBasisQuote: string;
}

/**
 * Realised P/L of one SELL fill against the position's cost basis, or `null`
 * when the prior position has no known cost basis (the caller MUST NOT
 * fabricate a number — a null cost basis means "do not book profit", not
 * "zero cost"). This is the accounting counterpart to {@link resolveFill}: the
 * fold reduces the held quantity, this prices the realised gain.
 *
 * Matched quantity is capped at the held quantity, so an overshoot sell
 * (selling more base than the bot tracks — adopted dust, an external transfer)
 * never books un-costed base as profit: only the tracked portion realises, and
 * its proceeds are taken pro-rata from the fill's total proceeds. This is the
 * single defence against the cost-basis-blind inflation the window-cashflow
 * aggregator used to produce.
 */
export function realizedPnlOnSell(
  prior: PositionView | null,
  sell: { readonly soldQty: Decimal; readonly proceeds: Decimal },
): RealizedPnl | null {
  if (!prior?.avgEntryPrice || !prior.heldQuantity) return null;
  const avgEntry = new Decimal(prior.avgEntryPrice);
  const heldBefore = new Decimal(prior.heldQuantity);
  if (heldBefore.lte(0) || sell.soldQty.lte(0)) return null;
  const matchedQty = Decimal.min(sell.soldQty, heldBefore);
  const costBasisQuote = matchedQty.times(avgEntry);
  // Pro-rata the fill's real proceeds onto the matched (tracked) portion so an
  // overshoot's un-costed base contributes neither cost nor proceeds.
  const matchedProceeds = sell.proceeds.times(matchedQty).div(sell.soldQty);
  return {
    realizedPnl: matchedProceeds.minus(costBasisQuote).toString(),
    costBasisQuote: costBasisQuote.toString(),
  };
}
