import { Decimal } from '@app/money';

import type { AdoptedFill, PositionView } from './contract.js';

/**
 * One raw exchange fill, normalised to Decimal. `price` is the order VWAP (cumQuoteQty/cumQty, live) or the single fill price (backtest); either is valid because folding sub-fills one at a time yields the same weighted average as folding their pre-combined VWAP once. `quantity` is the filled amount on BUY, the sold amount on SELL. SELL uses `price` only to value a leftover crumb against `minNotional`; pass a real VWAP to arm that check, or a non-positive value to skip it.
 */
export interface RawFill {
  readonly side: 'BUY' | 'SELL';
  readonly price: Decimal;
  readonly quantity: Decimal;
}

/** Largest share of the pre-sell position a leftover may be and still count as rounding residue rather than a deliberate remainder. Same ratio, and the same job, as `reconstructRoundTrips`'s cycle-close epsilon: a base-asset fee crumb is bounded by the fee rate and lands far under it, while a partial sell's remainder is a large fraction of what was held. */
const CRUMB_RATIO = new Decimal('0.01');

/**
 * Whether `quantity` is worth less than one minimum order, i.e. below the exchange's `NOTIONAL` floor.
 *
 * Split out from {@link isUnsellableDust} because the two callers want different rules from the same filter. A sell's leftover must ALSO be a negligible share of the position before it may be written off, since a deliberate partial sell can legitimately leave a sub-notional remainder. A wallet balance being cold-seeded as a new position has no prior to be a share of, so the value bound stands alone there.
 *
 * @param quantity - Base-asset amount to value.
 * @param price - Quote-asset price per unit, or null when no price is available and the answer must be false.
 * @param minNotional - The symbol's NOTIONAL order-value floor, or null to skip the bound.
 * @returns True only when a price and floor are both available and positive and the amount is worth less than the floor.
 */
export const isBelowMinNotional = (
  quantity: Decimal,
  price: Decimal | null,
  minNotional: Decimal | null,
): boolean =>
  minNotional !== null &&
  minNotional.gt(0) &&
  price !== null &&
  price.gt(0) &&
  quantity.times(price).lt(minNotional);

/**
 * Whether what a sell left behind is rounding residue the exchange will never let go of, rather than a position.
 *
 * Two independent filters can make a balance untradeable and both are asked, because a balance can clear one and fail the other by orders of magnitude. `LOT_SIZE.stepSize` is the smallest tradeable INCREMENT; `NOTIONAL.minNotional` is the smallest tradeable VALUE. The numbers that forced this are a live ENAUSDT wallet crumb of 0.01184 ENA against a 0.01 step and a 5 USDT floor: 1.18 steps wide, so the increment test waved it through, while being worth 0.0013 USDT and needing about 45.7 ENA before any sell of it could be placed at all. That crumb was untracked dust the wallet already held, NOT what an exit left behind — the exit emptied its position cleanly and the cycle archived, and the symbol stranded only when the boot cost-basis adoption picked the dust up as a fresh position a minute later. The two filters are the right pair; the case study was mis-attributed to the fold.
 *
 * The value bound additionally requires the leftover to be a negligible SHARE of the pre-sell position, and that qualifier is load-bearing. "Worth less than one minimum order" is a statement about a price at one instant, not about what the balance is: `rebalance` trims a holding down to its target weight on purpose, and a small target weight is legitimately worth less than the floor. Flattening on value alone would delete that position's cost basis and archive a phantom closed cycle. The share test separates the two cleanly, since ENAUSDT's crumb was 0.0028% of its position while a rebalance remainder is tens of percent. The increment bound needs no such qualifier because an increment is price-invariant.
 *
 * Each bound is skipped when its input is absent or non-positive rather than treated as zero, so a missing price or an unfiltered symbol can never classify a real position as dust.
 *
 * Assumed, not checked: that `minNotional` binds the order that would dispose of the crumb. Binance's NOTIONAL filter carries an `applyMinToMarket` flag that exempts MARKET orders when it is false, and `projectSymbolFilters` does not carry that flag, so on such a symbol a MARKET sell could in principle clear a sub-notional crumb that this code writes off. Deliberately accepted rather than plumbed through: the crumb is under 1% of the position by the share test, so the cost of being wrong is a rounding error of cost basis, while the cost of the opposite error is a position stranded on the dashboard forever with no way to close. A caller that acts on `isBelowMinNotional` alone, without the share test, does not inherit that argument and owns the trade-off itself; {@link isValuelessResidue} is what a caller with no prior quantity to divide by uses instead of owning it.
 *
 * @param remaining - What the sell left behind.
 * @param priorQuantity - Position size before the sell, the denominator of the share test; a non-positive value skips the value bound.
 * @param price - Quote-asset price per unit used to value the leftover, or null when no price is available and the value bound must be skipped.
 * @param stepSize - The symbol's LOT_SIZE increment, or null to skip the increment bound.
 * @param minNotional - The symbol's NOTIONAL order-value floor, or null to skip the value bound.
 * @returns True when the leftover is non-positive, below one increment, or a negligible share of the position that is also worth less than one minimum order.
 */
export const isUnsellableDust = (
  remaining: Decimal,
  priorQuantity: Decimal,
  price: Decimal | null,
  stepSize: Decimal | null,
  minNotional: Decimal | null,
): boolean => {
  if (remaining.lte(0)) return true;
  if (stepSize !== null && stepSize.gt(0) && remaining.lt(stepSize)) return true;
  const isCrumb = priorQuantity.gt(0) && remaining.div(priorQuantity).lt(CRUMB_RATIO);
  return isCrumb && isBelowMinNotional(remaining, price, minNotional);
};

/**
 * Whether `quantity` is worth so little against the exchange's `NOTIONAL` floor that it can only be fee-and-rounding residue, rather than a holding someone chose to keep.
 *
 * The bound for a caller that must DELETE a position and has no prior quantity to run {@link isUnsellableDust}'s share test against. Once a tracked position and the wallet have converged on the same crumb the share is exactly 1, so the share test can never fire, and the caller is left choosing between a bare `isBelowMinNotional` and nothing.
 *
 * A bare `isBelowMinNotional` is the wrong choice, because declining to CREATE a position and destroying an existing cost basis are not the same decision and do not deserve the same bar. A balance worth most of one minimum order is what a `rebalance` target weight looks like: real coins, a real cost basis, and a holding the operator can trade back up by raising the weight. Residue is orders of magnitude smaller — the live ENAUSDT crumb was 0.027% of its symbol's floor, against tens of percent for a deliberately-small holding. So the floor itself supplies the denominator the share test lost, at the same 1% ratio the share test uses.
 *
 * @param quantity - Base-asset amount to value; the caller passes the balance a position claim would be deleted over.
 * @param price - Quote-asset price per unit, or null when no price is available and the answer must be false rather than a guess.
 * @param minNotional - The symbol's NOTIONAL order-value floor, or null to skip the bound entirely.
 * @returns True only when a price and floor are both available and positive and the amount is worth less than 1% of one minimum order.
 */
export const isValuelessResidue = (
  quantity: Decimal,
  price: Decimal | null,
  minNotional: Decimal | null,
): boolean =>
  isBelowMinNotional(quantity, price, minNotional == null ? null : minNotional.times(CRUMB_RATIO));

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
  minNotional?: Decimal,
): SellAdoption;
export function resolveFill(
  prior: PositionView | null,
  fill: RawFill,
  stepSize?: Decimal,
  minNotional?: Decimal,
): AdoptedFill;
/**
 * Fold one raw fill onto a prior position view, producing the {@link AdoptedFill} the caller hands to `PositionStateAdapter.applyFill`. BUY accumulates a weighted-average entry price and held quantity; SELL reduces the held quantity, flattening to `empty` once it reaches zero. `prior` is null for a fresh position. This is the single source for the fold; the live executor and the backtest engine both call it so their position math cannot drift.
 *
 * `stepSize` flattens a SELL whose residual is below it: a remainder smaller than the smallest tradeable increment can never be sold, so the position IS flat. This clears the phantom-position left when a base-asset trading fee makes a full exit's sold quantity fall a fee's-worth short of the tracked (gross) held quantity, otherwise `avgEntryPrice` lingers and blocks re-entry.
 *
 * `minNotional` flattens the other unsellable residual, and it is the one LOT_SIZE misses. LOT_SIZE is the smallest tradeable INCREMENT; NOTIONAL is the smallest tradeable VALUE, and a residual can clear the first while failing the second by orders of magnitude. The live filters that motivated it are ENAUSDT's: a 0.01 step against a USD 5 floor, where 0.01184 ENA is 1.18 steps and worth USD 0.0013 — sellable by LOT_SIZE, refused by NOTIONAL forever. Those coins reached the wallet as untracked dust rather than as this fold's residual, so the bound protects against a residual of the same shape rather than against a case it has been observed to hit. See {@link isUnsellableDust} for why the value bound alone is not enough.
 *
 * Both bounds are optional, and omitting them (backtest, existing fixtures) restores the historical `lte(0)`-only behaviour, so golden replay is byte-identical.
 *
 * The flattened crumb's cost basis is intentionally NOT booked as realised P/L: `realizedPnlOnSell` matches only the sold quantity, so a residual below one step or below the order-value floor is written off silently rather than recorded as a sub-cent loss.
 *
 * @param prior - Position before this fill, or null for a fresh position.
 * @param fill - The fill to fold; on SELL, `price` is also what values the leftover against `minNotional`.
 * @param stepSize - The symbol's LOT_SIZE increment (live path only); omitted to keep replay-identical behaviour.
 * @param minNotional - The symbol's NOTIONAL order-value floor (live path only); omitted to keep replay-identical behaviour.
 * @returns The `buy`, `sell-reduce`, or `empty` adoption to apply to position state.
 */
export function resolveFill(
  prior: PositionView | null,
  fill: RawFill,
  stepSize?: Decimal,
  minNotional?: Decimal,
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
  // A residual the exchange would refuse to sell means the position IS flat — flatten it rather than stranding it. The wallet reconciler asks the same two questions of a wallet balance, so a crumb this fold writes off is not one the next reconcile pass adopts straight back.
  const flat = isUnsellableDust(
    remaining,
    prevQty,
    fill.price,
    stepSize ?? null,
    minNotional ?? null,
  );
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
