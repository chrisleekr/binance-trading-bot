import { Decimal } from '@app/money';

/** Base-asset wallet balance after a reserve has been removed from the bot's view. */
export interface AdjustedBalance {
  readonly free: Decimal;
  readonly locked: Decimal;
}

/**
 * Remove a per-(profile, symbol) base-asset RESERVE from the bot's view of the
 * wallet, draining `free` before `locked`.
 *
 * The reserve is the quantity the operator wants the bot to always hold ("hold
 * 50 ADA, trade on top"). Subtracting it at the worker's two wallet-read
 * chokepoints — boot position-adoption and per-tick sell-sizing — makes every
 * downstream balance reader see only the tradeable surplus, so the bot trades on
 * top of the reserve and never sells into it. Strategy-agnostic: the pure
 * strategy never learns the reserve exists.
 *
 * Drains `free` first because it is the immediately-sellable surface; whatever
 * remains of the reserve then comes out of `locked`. A null / empty /
 * non-positive / unparseable reserve returns the balance unchanged, so a symbol
 * with no reserve is byte-identical to the prior behaviour.
 */
export const reserveAdjustedBalance = (
  free: Decimal,
  locked: Decimal,
  reserve: string | null,
): AdjustedBalance => {
  if (reserve === null || reserve === '') return { free, locked };
  let r: Decimal;
  try {
    r = new Decimal(reserve);
  } catch {
    return { free, locked };
  }
  if (!r.isFinite() || r.lte(0)) return { free, locked };
  const fromFree = Decimal.min(free, r);
  const remaining = r.minus(fromFree);
  return {
    free: free.minus(fromFree),
    locked: Decimal.max(new Decimal(0), locked.minus(remaining)),
  };
};
