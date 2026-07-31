import { z } from 'zod';
import { PositiveDecimalString } from './decimal.js';
import { OrderSide } from './orders.js';

/**
 * Operator-initiated single-symbol order request. Exactly one of
 * `quantity` or `quoteAmount` must be supplied. The schema is strict so
 * legacy field names (e.g. `amount` + `sizeBy` from a hand-rolled curl)
 * are rejected at the 400 boundary instead of being silently stripped
 * by zod and dropped by the worker as `missing-amount`.
 *
 * Only MARKET and LIMIT are accepted. STOP_LOSS_LIMIT / TAKE_PROFIT_LIMIT
 * need a stop price this API cannot express and the worker cannot send, so
 * they are rejected at the boundary rather than 202-accepted and then
 * rejected by Binance after the operator was told the order was scheduled (#364).
 */
export const ManualOrderRequest = z
  .object({
    side: OrderSide,
    // Every operator-typed amount is a strictly-positive decimal. 0 or
    // negative is never a legitimate operator value; rejecting at the
    // schema returns a precise 400 instead of letting the worker silently
    // drop the order at min-qty.
    quantity: PositiveDecimalString.optional(),
    quoteAmount: PositiveDecimalString.optional(),
    price: PositiveDecimalString.optional(),
    type: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
  })
  .strict()
  .refine((body) => body.quantity !== undefined || body.quoteAmount !== undefined, {
    message: 'one of `quantity` or `quoteAmount` is required',
    path: ['quantity'],
  })
  .refine((body) => !(body.quantity !== undefined && body.quoteAmount !== undefined), {
    message: '`quantity` and `quoteAmount` are mutually exclusive',
    path: ['quoteAmount'],
  })
  // A price-less LIMIT was 202-accepted, then the worker omitted the absent
  // price and Binance rejected it (-1102) after the operator saw success.
  // Require the price at the boundary, the same class of guard as the
  // amount checks above (#364).
  .refine((body) => body.type === 'MARKET' || body.price !== undefined, {
    message: '`price` is required for a LIMIT order',
    path: ['price'],
  });
/** TS type derived from {@link ManualOrderRequest} so consumers don't re-run z.infer at every call site. */
export type ManualOrderRequest = z.infer<typeof ManualOrderRequest>;

/**
 * Acknowledgement that the manual order was queued. The order isn't placed
 * synchronously. The worker picks it up via the override-actions stream so
 * we return the scheduling receipt instead of a Binance order ID.
 */
export const ManualOrderResponse = z.object({
  scheduledAt: z.iso.datetime(),
  overrideActionId: z.uuid(),
});
/** TS type derived from {@link ManualOrderResponse} so consumers don't re-run z.infer at every call site. */
export type ManualOrderResponse = z.infer<typeof ManualOrderResponse>;

/** Body for `DELETE` of an open order. UUID identifies the local order row, not Binance's id. */
export const CancelOrderRequest = z.object({
  orderId: z.uuid(),
});
/** TS type derived from {@link CancelOrderRequest} so consumers don't re-run z.infer at every call site. */
export type CancelOrderRequest = z.infer<typeof CancelOrderRequest>;

/**
 * Bulk-fan-out manual order across every symbol that quotes against `quote`.
 * Drives the operator's "panic sell everything in USDT" flow; the API fans
 * the request out to a per-symbol override + tick so each matched symbol
 * places its order through the same path as a single manual order.
 */
export const ManualOrderAllRequest = z
  .object({
    quote: z.string().min(2).max(8),
    side: z.enum(['buy', 'sell']),
    marketQuantity: PositiveDecimalString.optional(),
    quoteAmount: PositiveDecimalString.optional(),
  })
  // Bulk fan-out is MARKET-only: a single limit price cannot be valid
  // across different symbols, and panic-sell is inherently a market action.
  // Each matched symbol maps to a MARKET `ManualOrderRequest`, which
  // requires exactly one amount — enforce the same invariant here so an
  // empty or ambiguous bulk request returns a precise 400 instead of every
  // per-symbol override being silently dropped at the worker's parse.
  .refine((body) => body.marketQuantity !== undefined || body.quoteAmount !== undefined, {
    message: 'one of `marketQuantity` or `quoteAmount` is required',
    path: ['marketQuantity'],
  })
  .refine((body) => !(body.marketQuantity !== undefined && body.quoteAmount !== undefined), {
    message: '`marketQuantity` and `quoteAmount` are mutually exclusive',
    path: ['quoteAmount'],
  });
/** TS type derived from {@link ManualOrderAllRequest} so consumers don't re-run z.infer at every call site. */
export type ManualOrderAllRequest = z.infer<typeof ManualOrderAllRequest>;

/**
 * Acknowledgement for bulk manual orders. `scheduled` is the number of
 * symbols whose order was actually enqueued (a per-symbol fan-out failure
 * is skipped, not aborting the batch). The fan-out is immediate, so
 * `firstFireAt` and `lastFireAt` are equal; both are retained for wire
 * compatibility with the UI.
 */
export const ManualOrderAllResponse = z.object({
  scheduled: z.number().int().nonnegative(),
  firstFireAt: z.iso.datetime(),
  lastFireAt: z.iso.datetime(),
});
/** TS type derived from {@link ManualOrderAllResponse} so consumers don't re-run z.infer at every call site. */
export type ManualOrderAllResponse = z.infer<typeof ManualOrderAllResponse>;

/**
 * Force-trigger response: same shape as {@link ManualOrderResponse} because
 * a force-trigger lands as an override action exactly like a scheduled
 * manual order.
 */
export const TriggerResponse = ManualOrderResponse;
/** TS type derived from {@link TriggerResponse} so consumers don't re-run z.infer at every call site. */
export type TriggerResponse = z.infer<typeof TriggerResponse>;

/**
 * Operator override of `avgEntryPrice`, used after a manual fill on the
 * Binance UI to teach the strategy where the cost basis is. Stored as a
 * decimal string for tick precision.
 */
export const AvgEntryPricePut = z.object({
  avgEntryPrice: PositiveDecimalString,
});
/** TS type derived from {@link AvgEntryPricePut} so consumers don't re-run z.infer at every call site. */
export type AvgEntryPricePut = z.infer<typeof AvgEntryPricePut>;

/**
 * Operator-pushed override that the worker reads from Redis at the start of
 * every tick. Three kinds:
 *   - `manual-order`: place this exact order with the operator-typed params.
 *     The strategy bypasses normal gates (kill-switch, lbp checks) because
 *     the operator is asserting intent. Payload mirrors `ManualOrderRequest`.
 *   - `trigger-buy` / `trigger-sell`: ask the strategy to run its normal
 *     buy- or sell-decision path with the Technicals gate forced open. The
 *     strategy still honors other safety gates so a double-click doesn't
 *     double-fire.
 *
 * `overrideActionId` is the UUID stamped on the `override_actions` audit
 * row at write time; the strategy folds it into the Binance `clientOrderId`
 * so retries within a single override coalesce at the exchange instead of
 * double-spending.
 */
export const ManualOverrideKind = z.enum(['manual-order', 'trigger-buy', 'trigger-sell']);
export type ManualOverrideKind = z.infer<typeof ManualOverrideKind>;

const ManualOverrideManualOrder = z.object({
  kind: z.literal('manual-order'),
  overrideActionId: z.uuid(),
  payload: ManualOrderRequest,
});
const ManualOverrideTriggerBuy = z.object({
  kind: z.literal('trigger-buy'),
  overrideActionId: z.uuid(),
});
const ManualOverrideTriggerSell = z.object({
  kind: z.literal('trigger-sell'),
  overrideActionId: z.uuid(),
});

export const ManualOverridePayload = z.discriminatedUnion('kind', [
  ManualOverrideManualOrder,
  ManualOverrideTriggerBuy,
  ManualOverrideTriggerSell,
]);
/** TS type derived from {@link ManualOverridePayload}. The shared shape that the API writes and the worker reads. */
export type ManualOverridePayload = z.infer<typeof ManualOverridePayload>;

/** Seconds the API-written override Redis key lives before TTL expiry; a tick that fires within the window consumes the override atomically via GETDEL. */
export const MANUAL_OVERRIDE_TTL_SECONDS = 300;
