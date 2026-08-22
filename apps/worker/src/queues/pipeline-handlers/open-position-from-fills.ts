// Pure cost-basis reconstruction for a CURRENTLY-OPEN position from Binance
// `myTrades` fills. Where `reconstruct-round-trips.ts` rebuilds CLOSED cycles
// for realised-P/L backfill, this answers a different question: given the full
// fill history of a symbol the wallet still holds, what is the open quantity
// and its average entry price? Used to self-heal a held-but-unpriced position
// (a fresh adopt, or a fill the worker never observed) so the entry gate stops
// treating it as flat. No I/O, no clock: fills in, open position out.

import { Decimal } from '@app/money';
import type { MyTradeDto } from '@app/binance';

/**
 * The fee's ASSET decides whether it left the base wallet, never the fill's side. Binance charges a spot BUY in the base asset by default, which is the common case: `qty` is gross and the account is credited `qty - commission`. But a SELL can charge in the base asset too, whenever the base IS the discount asset — a BNBUSDT sell with the BNB discount enabled pays its fee in BNB, and that BNB leaves the same wallet line the position is denominated in. Keying off `isBuyer` would silently miss it, which is why the user-stream frame contract says to compare against the base asset instead.
 *
 * @param fill - One raw `myTrades` row.
 * @param baseAsset - The symbol's base asset, from the caller's own exchangeInfo projection; the authoritative answer to "did this fee come out of the coin being tracked?".
 * @returns The base-asset amount this fill's commission removed from the wallet, or zero when the fee was charged in some other asset, is unparseable, or is not positive.
 */
const baseAssetCommission = (fill: MyTradeDto, baseAsset: string): Decimal => {
  if (fill.commissionAsset !== baseAsset) return new Decimal(0);
  try {
    const fee = new Decimal(fill.commission);
    return fee.gt(0) ? fee : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};

/**
 * Walk fills oldest-first under the average-cost method. A BUY grows open
 * quantity and open quote cost; a SELL shrinks both proportionally so the
 * average entry price is unchanged by a sale (the realised P/L of the sold
 * lot is out of scope here). Returns `null` when nothing remains open
 * (fully sold, or empty history).
 *
 * Base-asset commission is netted out of the walk, and that is the difference between a position and an accounting artifact. Every gross `qty` overstates what the account received by its fee, so a symbol whose exits sold exactly what it held still leaves the walk holding the sum of every past cycle's fee — the live ENAUSDT case accumulated 0.87 ENA that way against a wallet of 0.01184. The quote cost is deliberately NOT netted with it, so the average entry price rises from the gross figure to the fee-netted one: that is the same number the fill-adopter divides `cummulativeQuoteQty` by the net quantity to get, and the two agreeing is the point — a cost basis this walk reconstructs must be indistinguishable from one a live fill produced.
 *
 * @param fills - The symbol's `myTrades` rows in any order; the walk sorts them oldest-first itself.
 * @param baseAsset - The symbol's base asset, which is the coin the returned quantity is denominated in and the only commission asset that reduces it.
 * @param walletCap - Ceiling for the returned quantity, the balance the wallet actually holds, or null/omitted to return the walk's own figure. A truncated 1000-fill window can only ever over-state what is open, and the ledger row this feeds must not be able to claim coins the account does not have.
 * @returns The open quantity and its average entry price, or null when the walk closes flat or the cap leaves nothing.
 */
export const openPositionFromFills = (
  fills: readonly MyTradeDto[],
  baseAsset: string,
  walletCap?: Decimal | null,
): { quantity: string; avgEntryPrice: string } | null => {
  const sorted = [...fills].sort((a, b) => a.time - b.time || a.id - b.id);
  let openQty = new Decimal(0);
  let openCost = new Decimal(0);
  for (const f of sorted) {
    const qty = new Decimal(f.qty);
    const fee = baseAssetCommission(f, baseAsset);
    if (f.isBuyer) {
      openQty = openQty.add(qty.minus(fee));
      openCost = openCost.add(f.quoteQty);
      continue;
    }
    // SELL: reduce cost proportionally before shrinking quantity so the
    // remaining average stays put. Clamp at zero so an oversized sell (base
    // sold from a pre-history lump) can't drive cost or quantity negative.
    // A base-asset fee here left the wallet ON TOP of what was sold, so the
    // position shrinks by both.
    const sold = qty.plus(fee);
    if (openQty.gt(0)) {
      const remaining = Decimal.max(openQty.sub(sold), 0);
      openCost = openCost.mul(remaining).div(openQty);
    }
    openQty = Decimal.max(openQty.sub(sold), 0);
  }
  if (openQty.lte(0)) return null;
  // Cap the quantity, never the average: the price is what the walk paid per unit and holds whatever slice of it the wallet still backs.
  const quantity = walletCap != null && walletCap.lt(openQty) ? walletCap : openQty;
  if (quantity.lte(0)) return null;
  return { quantity: quantity.toFixed(), avgEntryPrice: openCost.div(openQty).toFixed() };
};
