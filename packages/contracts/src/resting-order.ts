// "Is this SELL still holding coins on the exchange?" — the one predicate three
// layers must agree on: the api's orphan-adoption guard, the web's adopt list, and
// momentum's protective-stop arm. Three copies of the same condition is how one of
// them silently drifts and re-admits the bug they exist to prevent.
//
// A resting SELL locks its base until it fills or is cancelled. Adopting one, or
// arming a stop behind one, gives the strategy a position it cannot protect: every
// stop it sizes is unfundable and Binance answers -2010 to every attempt, forever.

/**
 * Order statuses that mean the order is OFF the book. Anything else — `NEW`,
 * `PARTIALLY_FILLED`, `PENDING_NEW` (an OCO leg not yet promoted),
 * `PENDING_CANCEL`, and any status Binance adds tomorrow — is treated as still
 * resting. A DENYLIST, not an allowlist, so an unknown status fails CLOSED (we
 * assume the coins are still locked) rather than waving the order through.
 *
 * https://developers.binance.com/docs/binance-spot-api-docs/enums (Order status)
 */
const TERMINAL_ORDER_STATUSES: ReadonlySet<string> = new Set([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
  'EXPIRED_IN_MATCH',
]);

/** True when the order is still on the book (see {@link TERMINAL_ORDER_STATUSES}). */
export const isRestingStatus = (status: string): boolean =>
  !TERMINAL_ORDER_STATUSES.has(status.toUpperCase());

/**
 * True when this order is a SELL still resting on the exchange — i.e. it is
 * holding base coins that neither the bot nor the operator can spend until it is
 * cancelled. Type-agnostic on purpose: an OCO leg, a TAKE_PROFIT_LIMIT and a plain
 * LIMIT lock the base identically, so the order TYPE says nothing here.
 *
 * A resting BUY locks quote, not coins, and is not what this asks about.
 */
export const isRestingSell = (order: { readonly side: string; readonly status: string }): boolean =>
  order.side.toUpperCase() === 'SELL' && isRestingStatus(order.status);
