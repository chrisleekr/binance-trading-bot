import type { TTState } from './schema.js';

/** Later of two nullable ms stamps; null is "absent" and never wins over a value. */
const laterMs = (a: number | null, b: number | null): number | null => {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
};

/**
 * Graft TT's exit-latch fields onto a winner body after a tick-commit CAS miss.
 *
 * These fields are stamped once at a sell-exit transition and are NOT
 * re-derivable next tick (the position is flat by then): dropping them on a CAS
 * miss lets the bot re-buy straight into the drop it just sold. `base` is the
 * concurrent fill's authoritative body (position/orders/grid); `latchSource` is
 * the tick's would-be next state carrying the fresh stamps.
 *
 * The merge takes the more-recent value per field so a cooldown is never moved
 * earlier: the loss-cooldown anchor and the force-sell re-entry deadline both
 * read "later = more conservative", and a scheduled re-arm buy delayed is safe.
 * `lastLossExitReason` follows whichever `lastLossExitAt` won so the display
 * context stays paired with its anchor. Pure: neither input is mutated.
 */
export const mergeTTLatchFields = (input: {
  readonly base: TTState;
  readonly latchSource: TTState;
}): TTState => {
  const { base, latchSource } = input;
  const lastLossExitAt = laterMs(base.lastLossExitAt, latchSource.lastLossExitAt);
  // Pair the reason with the anchor that won. Prefer latchSource on a tie so the
  // tick's fresh exit reason lands when both stamps share a millisecond.
  const lastLossExitReason =
    lastLossExitAt !== null && lastLossExitAt === latchSource.lastLossExitAt
      ? latchSource.lastLossExitReason
      : lastLossExitAt !== null && lastLossExitAt === base.lastLossExitAt
        ? base.lastLossExitReason
        : null;
  return {
    ...base,
    lastLossExitAt,
    lastLossExitReason,
    forceSellCooldownUntilMs: laterMs(
      base.forceSellCooldownUntilMs,
      latchSource.forceSellCooldownUntilMs,
    ),
    autoTriggerBuyAtMs: laterMs(base.autoTriggerBuyAtMs, latchSource.autoTriggerBuyAtMs),
  };
};
