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
      return `The bot thinks it holds this position, but the coins are not free in your Binance wallet — they were moved, withdrawn, or are locked in another order — so it cannot place its protective stop (the automatic sell that caps a loss).${detail} Move the coins back (or cancel whatever is holding them) and the stop arms itself on the next check. Until then this position has no safety net.`;
    }
    case 'resting-stop-short-of-position': {
      const resting = str(d, 'resting');
      const held = str(d, 'held');
      // Named as a partial safety net rather than none, because that is what it is, and the badge derived from `guarded` says the same thing. Telling this operator the position is unprotected would send them to cancel a stop that is protecting most of it.
      const cover =
        resting && held ? ` It sells ${resting} coins, and the position now holds ${held}.` : '';
      return `The protective stop (the automatic sell that caps a loss) resting on Binance covers only part of this position, because the position grew after that stop was placed.${cover} Binance trails the stop from the highest price it has seen since the order went on, and replacing the order restarts that from today's price, which would hand back a worse trigger on the coins already covered. So the bot keeps the stop it has until the price sets a new high, at which point it re-arms for the full amount. Until then the extra coins have no safety net; selling them by hand also clears it.`;
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
      const resting = str(d, 'resting');
      const held = str(d, 'held');
      const required = str(d, 'required');
      // The full-size refusal carries `skip`; the foreign-lock classifier does not, so this field identifies the producer.
      const fullSizeRefusal = typeof d?.['skip'] === 'string';
      // The `required` figure is worked out at the price written on the order, and which price that is depends on the order. An ordinary stop sells down to a limit a little under the trigger, so calling it "the stop price" invites the operator to check the number against the trigger and conclude the bot is wrong. A native trailing stop carries no price at all, so naming its trigger "the price it would sell at" names the one price that order will not sell at. Blockers persisted before these fields existed carry no `checkedAt`, and they must still read as a clean sentence rather than quoting nothing; an old one carrying `checkedAt` without the leg was a priced stop, which is what the limit wording describes.
      const checkedAt = str(d, 'checkedAt');
      const checkedAtLeg = str(d, 'checkedAtLeg');
      const atPrice = !checkedAt
        ? 'the stop price'
        : checkedAtLeg === 'trigger'
          ? `its trigger price (${checkedAt})`
          : checkedAtLeg === 'market'
            ? `the current market price (${checkedAt})`
            : `the price it would sell at (${checkedAt})`;
      // Which price the bot chose is its own decision, not an exchange rule, so the copy attributes it to the bot: Binance values a market-type order at an average of recent trade prices, and only when `applyMinToMarket` is set. Naming Binance as the one that measured would send an operator to divide the exchange minimum by a price the exchange never looked at. `trigger` is now the degraded case rather than the normal one, so it says why the bot settled for it and which way the error runs.
      const legNote = !checkedAt
        ? ''
        : checkedAtLeg === 'market'
          ? ' This stop is a trailing one with no price written on it — it sells at whatever the market pays the moment it fires — so the bot sizes it against the market price.'
          : checkedAtLeg === 'trigger'
            ? ' This stop is a trailing one with no price written on it, and the bot could not read a usable market price this tick, so it fell back to the trigger. That is the cautious side: the trigger sits below the market, so the bot asks for more coins than it strictly needs rather than fewer.'
            : '';
      const lead = fullSizeRefusal
        ? `The whole position${held ? ` (${held} coins held)` : ''} is below Binance's minimum sellable size${required ? ` (${required} coins required)` : ''} at ${atPrice}, so the bot cannot place a protective stop (the automatic sell that caps a loss).${legNote}`
        : `Too few coins are free to sell: what is left is below Binance's minimum order size, so the bot cannot place a protective stop (the automatic sell that caps a loss) against it.${free ? ` Only ${free} coins are free.` : ''}`;
      // The badge reads this same guarded flag, so deriving the copy from it keeps the two surfaces from disagreeing about whether the position has a safety net.
      const guarded = blockerPositionGuarded(blocker);
      const remedy =
        resting && guarded
          ? ' The existing protective stop stays in place at its old trigger and still covers the whole position, so it cannot be re-armed at a new level until the position is topped up or sold by hand.'
          : resting
            ? ` An older protective stop still rests at its previous trigger but covers only ${resting}${held ? ` of the ${held} coins held` : ' coins held'}; the rest has no safety net until the position is topped up or sold by hand.`
            : fullSizeRefusal
              ? ' Top the position up above the minimum or sell it by hand. Until then this position has no safety net.'
              : ' Free up more of the position — cancel other sell orders on this pair — and the stop arms itself on the next check. Until then this position has no safety net.';
      return `${lead}${remedy}`;
    }
    default:
      return 'The protective stop (the automatic sell that caps a loss) is not in place on this position right now.';
  }
}
