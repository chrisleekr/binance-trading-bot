// Per-call record of cancels that did NOT provably clear the exchange.
//
// A tick's decision chain replaces a resting order by cancelling the old one and
// placing a new one. If the cancel fails, the old order is STILL RESTING on
// Binance — and the place path's `upsertLive` would nonetheless stamp the old
// row CANCELED to free the live slot. That is how the bot mints orphans: two live
// orders on the exchange, one of them recorded as cancelled.
//
// The ledger carries that fact from the cancel handler to the place handler
// within one `applyAll`. It is deliberately in-memory and per-call: it answers
// "did a cancel I just attempted fail?", not "is anything stale anywhere", so it
// needs no shared state and is not a lock.
//
// BELT AND BRACES, NOT THE LIVE MECHANISM. `applyAll` now BREAKS the decision
// chain on any failed order decision, so a place-order queued behind a failed
// cancel never runs and `hasUnresolved` cannot return true in production. It stays
// because the `closePrevious` guarantee it encodes is a real-money invariant and
// must not depend on the chain-break staying in place: if a future change lets a
// place run behind a failed cancel, this is what stops the still-resting order's
// row from being stamped CANCELED.

import { Decimal, isPlainDecimalString } from '@app/money';

/** Marks the whole symbol when the failed cancel's intent could not be resolved. */
const ANY_INTENT = '*';

export interface CancelLedger {
  /**
   * Record that a cancel for this slot failed. `intent` is omitted when the
   * cancelled order's local row could not be read, so its slot is unknown — the
   * whole symbol is then treated as unresolved, which is the fail-safe reading.
   */
  markUnresolved(symbol: string, intent?: string): void;
  hasUnresolved(symbol: string, intent: string): boolean;
  /**
   * Record that a cancel PROVABLY cleared the exchange and gave an asset back.
   * `quantity` is the un-filled remainder the cancelled order was holding, or
   * `null` when the release is real but its size could not be read.
   */
  markReleased(asset: string, quantity: string | null): void;
  /**
   * What this batch's successful cancels handed back in `asset`:
   *   - `Decimal(0)` — nothing was released,
   *   - `Decimal(n)` — that much was,
   *   - `null` — something was released but we cannot say how much, so no funding
   *     judgment may be made on this asset at all.
   */
  releasedFor(asset: string): Decimal | null;
}

/**
 * The released-balance half exists because a resting order LOCKS what it holds.
 * The tick's exit is `[cancel our resting stop, place the market SELL]`, and the
 * cached balance snapshot — refreshed asynchronously off the user stream — still
 * shows that base as locked when the place runs microseconds later. Judging the
 * SELL's funding against that snapshot would skip the EXIT itself. Crediting back
 * what the cancel just freed is what makes the pre-flight see the wallet as it
 * actually is by the time the order is sent.
 *
 * It is an additive credit, not a reservation: nothing owns it, nothing releases
 * it, and it dies with the batch.
 */
export const createCancelLedger = (): CancelLedger => {
  const slots = new Set<string>();
  const released = new Map<string, Decimal | null>();
  return {
    markUnresolved(symbol, intent) {
      slots.add(`${symbol}:${intent ?? ANY_INTENT}`);
    },
    hasUnresolved(symbol, intent) {
      return slots.has(`${symbol}:${ANY_INTENT}`) || slots.has(`${symbol}:${intent}`);
    },
    markReleased(asset, quantity) {
      const prior = released.get(asset);
      // An unquantified release poisons the asset for the whole batch: a partial
      // credit would understate the free balance and could still veto the order.
      if (prior === null) return;
      if (quantity === null || !isPlainDecimalString(quantity)) {
        released.set(asset, null);
        return;
      }
      released.set(asset, (prior ?? new Decimal(0)).plus(new Decimal(quantity)));
    },
    releasedFor(asset) {
      const credit = released.get(asset);
      return credit === undefined ? new Decimal(0) : credit;
    },
  };
};
