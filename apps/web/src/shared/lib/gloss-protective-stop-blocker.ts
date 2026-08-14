// Turn a strategy's protective-stop blocker (reason code + sparse detail) into one
// plain-language sentence for a non-finance operator (invariant #3). Separate from
// the entry-blocker gloss because it answers a different, louder question: the
// position is OPEN and running without its safety net. Detail numbers arrive as
// strings and are shown verbatim; only the band refusal's percentages are
// formatted, and that is done by the strategy package so the push alert cannot
// quote a different figure for the same refusal.

import { explainProtectiveStopBandRefusal } from '@app/strategy-core';

/** Loose blocker shape: any strategy's reason code + optional sparse detail. */
interface ProtectiveStopBlocker {
  readonly reason: string;
  readonly detail?: Record<string, unknown> | undefined;
}

function str(detail: ProtectiveStopBlocker['detail'], key: string): string | null {
  const v = detail?.[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
}

/**
 * How Binance derives the price it bands orders against. A window of 0 means it
 * compares against the last trade rather than an average, so the clause changes
 * shape and not just its number.
 */
function referenceWindow(avgPriceMins: string | null): string {
  if (avgPriceMins === null) return 'a reference price it works out itself';
  if (avgPriceMins === '0') return 'the price of the last trade on this pair';
  return `the average price over the last ${avgPriceMins} minutes`;
}

/**
 * Whether the strategy asserts the position is still covered by a working stop
 * on Binance despite the blocker. Callers use it to pick between "no safety net"
 * and "the safety net is stale", which are different amounts of danger —
 * painting the second one red is what teaches an operator to ignore the first.
 *
 * Only an explicit `true` counts. A blocker that does not carry the field says
 * nothing about coverage rather than denying it, and unknown coverage is shown
 * as uncovered: over-warning costs a glance, under-warning costs the position.
 */
export function blockerPositionGuarded(blocker: ProtectiveStopBlocker): boolean {
  return blocker.detail?.['guarded'] === true;
}

export function glossProtectiveStopBlocker(blocker: ProtectiveStopBlocker): string {
  const d = blocker.detail;
  switch (blocker.reason) {
    case 'base-locked-by-foreign-order': {
      const required = str(d, 'required');
      const free = str(d, 'free');
      const detail =
        required && free
          ? ` The stop needs ${required} coins but only ${free} are free to sell.`
          : '';
      return `Your coins are locked by another sell order already resting on Binance — often one left behind by a deleted profile — so the bot cannot place its protective stop (the automatic sell that caps a loss).${detail} Cancel that order on Binance and the stop arms itself on the next check. Until then this position has no safety net.`;
    }
    case 'base-short-of-tracked-position': {
      const required = str(d, 'required');
      const detail = required
        ? ` The stop needs ${required} coins but none are free to sell.`
        : ' None of the coins are free to sell.';
      return `The bot thinks it holds this position, but the coins are not free in your Binance wallet — they were moved, withdrawn, or are being held back by a base reserve — so it cannot place its protective stop (the automatic sell that caps a loss).${detail} Move the coins back (or lower the reserve) and the stop arms itself on the next check. Until then this position has no safety net.`;
    }
    case 'price-outside-exchange-band': {
      const price = str(d, 'price');
      // Which end of the range was breached. A stop priced ABOVE the ceiling is
      // rarer but possible, and quoting the floor at that operator produces a
      // sentence that contradicts itself. Absent field reads as the floor, the
      // only bound earlier blockers could describe.
      const overCeiling = str(d, 'bound') === 'ceiling';
      const limit = overCeiling ? str(d, 'ceiling') : str(d, 'floor');
      // Binance bands against an average the bot cannot read from inside a tick,
      // so the limit here is estimated from the current price. Saying so keeps an
      // operator from treating a near-miss figure as the exact rejection point.
      const basis = ` Binance works that limit out from ${referenceWindow(str(d, 'avgPriceMins'))}; the bot estimates it from the current price, so these numbers are close rather than exact.`;
      const range =
        limit && price
          ? ` The stop would be priced at ${price}, against an estimated ${overCeiling ? 'highest' : 'lowest'} allowed sell of ${limit}.`
          : '';
      // The sentences come from the strategy package that mints the refusal, and
      // the push alert reads the same ones. Wording this screen independently is
      // how the two surfaces ended up recommending opposite fixes for one block —
      // including which of them claimed the position was unguarded.
      const copy = explainProtectiveStopBandRefusal(d ?? {});
      return `${copy.situation}${basis}${range} ${copy.exposure}${copy.remedy === '' ? '' : ` ${copy.remedy}`}`;
    }
    case 'base-below-exchange-minimum': {
      const free = str(d, 'free');
      const detail = free ? ` Only ${free} coins are free.` : '';
      return `Too few coins are free to sell: what is left is below Binance's minimum order size, so the bot cannot place a protective stop (the automatic sell that caps a loss) against it.${detail} Free up more of the position — cancel other sell orders on this pair, or lower any base reserve — and the stop arms itself on the next check. Until then this position has no safety net.`;
    }
    default:
      return 'The protective stop (the automatic sell that caps a loss) is not in place on this position right now.';
  }
}
