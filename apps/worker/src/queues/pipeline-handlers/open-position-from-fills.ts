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
 * Walk fills oldest-first under the average-cost method. A BUY grows open
 * quantity and open quote cost; a SELL shrinks both proportionally so the
 * average entry price is unchanged by a sale (the realised P/L of the sold
 * lot is out of scope here). Commission is ignored for the cost basis, matching
 * `reconstruct-round-trips.ts`. Returns `null` when nothing remains open
 * (fully sold, or empty history).
 */
export const openPositionFromFills = (
  fills: readonly MyTradeDto[],
): { quantity: string; avgEntryPrice: string } | null => {
  const sorted = [...fills].sort((a, b) => a.time - b.time || a.id - b.id);
  let openQty = new Decimal(0);
  let openCost = new Decimal(0);
  for (const f of sorted) {
    const qty = new Decimal(f.qty);
    if (f.isBuyer) {
      openQty = openQty.add(qty);
      openCost = openCost.add(f.quoteQty);
      continue;
    }
    // SELL: reduce cost proportionally before shrinking quantity so the
    // remaining average stays put. Clamp at zero so an oversized sell (base
    // sold from a pre-history lump) can't drive cost or quantity negative.
    if (openQty.gt(0)) {
      const remaining = Decimal.max(openQty.sub(qty), 0);
      openCost = openCost.mul(remaining).div(openQty);
    }
    openQty = Decimal.max(openQty.sub(qty), 0);
  }
  if (openQty.lte(0)) return null;
  return { quantity: openQty.toFixed(), avgEntryPrice: openCost.div(openQty).toFixed() };
};
