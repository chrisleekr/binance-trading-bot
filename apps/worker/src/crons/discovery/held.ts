// Wallet-held check for the discovery reap guard.

import { Decimal, isPlainDecimalString } from '@app/money';
import { isValuelessResidue } from '@app/strategy-core';

/**
 * Parse a nullable decimal-string input, degrading an absent or malformed value to null so the value bound disarms rather than guessing.
 *
 * The grammar test is the whole guard, and it is load-bearing in both directions. On the FLOOR: `decimal.js` reads `'Infinity'` as a value rather than throwing, and an infinite `minNotional` makes every balance compare as worth less than it, so a symbol whose floor arrived unreadable would be reaped instead of kept. On the PRICE: `decimal.js` also reads exponent notation, and `1e-9000` is finite, positive and nine thousand orders of magnitude below any real quote, so it values a genuine position at nothing, arms the residue bound and reaps a live holding. Both are refused here because neither is decimal text the wire legitimately sends.
 *
 * No try/catch and no finiteness test behind it, because the grammar leaves them nothing to catch: every string it admits is plain decimal notation, which `decimal.js` parses without throwing and cannot overflow to a non-finite value from any length a wire delivers. Relaxing the grammar would put both back in scope.
 *
 * The exchange narrows its own symbol filters to this grammar upstream, but the ticker's `lastPrice` reaches here straight off `JSON.parse` with nothing in between, so this is the boundary that has to enforce it.
 *
 * @param value - A decimal string off the exchange's symbol filters or ticker feed, or null when that field was absent. Not assumed numeric: these arrive as strings from an upstream this code does not validate.
 * @returns The parsed value, or null when it was absent or not plain decimal text — both of which disarm the bound rather than being guessed at.
 */
const parse = (value: string | null): Decimal | null =>
  value !== null && isPlainDecimalString(value) ? new Decimal(value) : null;

/**
 * Whether the wallet holds an amount of the symbol's base asset (free + locked, already summed into `wallet`) that could still be a position this profile has not adopted yet.
 *
 * Two bounds, and they answer different halves of that question. `minQty` is the LOT_SIZE floor: below one lot there is nothing an order could even name. `minNotional` is the order-VALUE floor, and it is what makes the difference between a balance no one can sell and a holding someone chose to keep — a balance under it is refused by the exchange on every SELL, so no strategy, operator or reconciler can ever clear it. Treating such a balance as held pins the discovery slot for the life of the account: the symbol keeps its subscription and ticks forever over coins that can never move.
 *
 * The value bound is {@link isValuelessResidue}, the same predicate and the same 1%-of-one-minimum-order bar the three other doors onto this decision use — the boot prune (`isPhantomLedgerRow`), the reconfigure reconcile, and the fill adopter. A bare `isBelowMinNotional` would be the wrong bar here for the reason those three name: a holding worth most of one minimum order is what a deliberately-small position looks like, and it can become sellable again on the next move up. Only residue orders of magnitude below the floor is provably inert.
 *
 * Fail-safe in one direction only. A missing or unparseable price or floor DISARMS the value bound and the answer falls back to the `minQty` test alone, because this guard's `true` prevents an action and its `false` permits one: an input that could not be read must never be the reason a symbol is abandoned. Throws (via decimal.js) on a non-numeric `minQty`; the caller wraps and fails safe.
 *
 * @param wallet - Free + locked balance per base asset, as the discovery cycle read it from the exchange.
 * @param baseAsset - The symbol's base asset, the wallet key to test. An asset absent from the wallet reads as zero.
 * @param minQty - The symbol's LOT_SIZE minimum order quantity, as a decimal string. Required: below it there is no order to place.
 * @param minNotional - The symbol's NOTIONAL order-value floor as a decimal string, or null to skip the value bound.
 * @param referencePrice - Latest quote-asset price per unit of the base asset, valuing the balance against `minNotional`, or null to skip the value bound rather than guess a price.
 * @returns True when the balance could still back an unadopted position, so the reap must be refused.
 */
export const baseAssetHeld = (
  wallet: Record<string, Decimal>,
  baseAsset: string,
  minQty: string,
  minNotional: string | null,
  referencePrice: string | null,
): boolean => {
  const balance = wallet[baseAsset] ?? new Decimal(0);
  if (balance.lt(new Decimal(minQty))) return false;
  return !isValuelessResidue(balance, parse(referencePrice), parse(minNotional));
};
