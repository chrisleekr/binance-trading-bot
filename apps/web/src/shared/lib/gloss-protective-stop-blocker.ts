// Turn a strategy's protective-stop blocker (reason code + sparse detail) into one
// plain-language sentence for a non-finance operator (invariant #3). Separate from
// the entry-blocker gloss because it answers a different, louder question: the
// position is OPEN and running without its safety net. Stays off decimal.js —
// detail numbers arrive as strings and are shown verbatim.

/** Loose blocker shape: any strategy's reason code + optional sparse detail. */
interface ProtectiveStopBlocker {
  readonly reason: string;
  readonly detail?: Record<string, unknown> | undefined;
}

function str(detail: ProtectiveStopBlocker['detail'], key: string): string | null {
  const v = detail?.[key];
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
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
    case 'base-below-exchange-minimum': {
      const free = str(d, 'free');
      const detail = free ? ` Only ${free} coins are free.` : '';
      return `Too few coins are free to sell: what is left is below Binance's minimum order size, so the bot cannot place a protective stop (the automatic sell that caps a loss) against it.${detail} Free up more of the position — cancel other sell orders on this pair, or lower any base reserve — and the stop arms itself on the next check. Until then this position has no safety net.`;
    }
    default:
      return 'The protective stop (the automatic sell that caps a loss) is not in place on this position right now.';
  }
}
