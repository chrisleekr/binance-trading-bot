import { assertClientOrderId, djb2Hex } from '@app/strategy-core';

/**
 * Deterministic clientOrderId for an entry / exit. Folds the triggering
 * candle's close time into the hash so each cross-cycle gets a distinct id
 * while a retried tick on the same candle coalesces at Binance rather than
 * double-placing. `e` = entry, `x` = exit.
 */
export const entryClientOrderId = (
  profileId: string,
  symbol: string,
  candleCloseMs: number,
): string => assertClientOrderId(`mo-${djb2Hex(`${profileId}|${symbol}|${candleCloseMs}`)}-e`);

export const exitClientOrderId = (
  profileId: string,
  symbol: string,
  candleCloseMs: number,
): string => assertClientOrderId(`mo-${djb2Hex(`${profileId}|${symbol}|${candleCloseMs}`)}-x`);

/**
 * Deterministic clientOrderId for the resting protective stop. Stable per
 * (profile, symbol) — no candle time — so the strategy re-finds the SAME resting
 * order tick after tick to leave it in place, reprice it, or cancel it. `ps` =
 * protective stop.
 */
export const protectiveStopClientOrderId = (profileId: string, symbol: string): string =>
  assertClientOrderId(`mo-${djb2Hex(`${profileId}|${symbol}`)}-ps`);

/**
 * Authoritative orphan attribution. Only the protective stop is re-derivable: it
 * is the one id momentum keys on `(profile, symbol)` alone. Entry / exit ids fold
 * the triggering candle's close time into the hash, so they cannot be enumerated
 * and must NOT be claimed — an order the strategy cannot prove is its own is not
 * adoptable into it.
 *
 * That the stop is exactly the adoptable case is not a coincidence: a stop rests
 * on the book for days, so it is the order most likely to be orphaned by a crash
 * between placement and its local row — and the one whose mis-adoption locks the
 * base asset against its real owner forever.
 */
export const momentumAttributeOrder = (input: {
  readonly clientOrderId: string;
  readonly profileId: string;
  readonly symbol: string;
}): { readonly intent: string } | null =>
  input.clientOrderId === protectiveStopClientOrderId(input.profileId, input.symbol)
    ? { intent: 'protective-stop' }
    : null;
