import type { ManualOrderRequest } from '@app/contracts';
import {
  assertClientOrderId,
  djb2Hex,
  type Decision,
  type OpenOrder,
  type OrderIntent,
  type OrderParams,
  type TickInput,
} from '@app/strategy-core';
import {
  firstBuyClientOrderId,
  gridBuyClientOrderId,
  manualOrderClientOrderId,
  protectiveStopClientOrderId,
  pyramidBuyClientOrderId,
} from './client-order-id.js';
import { resolveMakerEntryLimit } from './execution.js';
import type { TTBundle, TTConfig, TTState } from './schema.js';

/**
 * The order intents trailing-trade emits. The core contract leaves
 * `OrderIntent.reason` an open string (each strategy owns its vocabulary);
 * TT pins its own set here for type-safety at the decision-build sites. These
 * land verbatim in `orders.intent`, which has no CHECK constraint.
 */
export const TT_INTENTS = [
  'grid-buy',
  'bull-pyramid',
  'grid-sell',
  'grid-stop-loss',
  'protective-stop',
  'technicals-force-sell',
  'regime-exit',
  'discovery-time-stop',
  'break-even-stop',
  'time-stop',
  'manual',
] as const;

export type TTIntent = (typeof TT_INTENTS)[number];

/** Whether the open-order set already contains a BUY for `symbol`; gates first-buy emission so retries coalesce at Binance instead of double-spending. */
export const hasOpenBuyForSymbol = (orders: readonly OpenOrder[], symbol: string): boolean =>
  orders.some((o) => o.symbol === symbol && o.side === 'BUY');

/**
 * Build the `place-order` Decision for the first-buy. Quantity is already
 * filter-validated by `computeFirstBuyQuantity`; this helper only assembles
 * the Decision payload and assigns the retry-stable clientOrderId.
 */
export const buildFirstBuyDecision = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  quantity: string,
): Decision => {
  const intent: OrderIntent = {
    symbol: input.market.symbol,
    side: 'BUY',
    // 'grid-buy' is the canonical name for any strategy-initiated BUY.
    reason: 'grid-buy',
    clientOrderId: firstBuyClientOrderId(input.profile.id, input.market.symbol),
  };
  // Maker entry mode rests a passive LIMIT below the price (provides liquidity,
  // no spread cross / slippage) instead of a taker MARKET buy; undefined in the
  // default market mode keeps the byte-identical MARKET shape.
  const makerLimit = resolveMakerEntryLimit(input);
  const params: OrderParams =
    makerLimit !== undefined
      ? { type: 'LIMIT', quantity, price: makerLimit, timeInForce: 'GTC' }
      : { type: 'MARKET', quantity };
  return { type: 'place-order', intent, params };
};

/**
 * Build the `place-order` Decision for a grid-level BUY (entry at
 * index 0 or promotion at index N > 0). The level index is stamped
 * into `intent.meta.gridTradeIndex` so the executor's persistOrder call
 * writes it to the generic `orders.meta` jsonb, satisfying the dashboard's
 * grid panel and the audit trail. ClientOrderId is seeded with the level
 * so a retry of the same level coalesces at Binance but adjacent
 * levels never share an id. `quantity` MUST be filter-validated by
 * the caller.
 */
export const buildGridBuyDecision = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  quantity: string,
  gridIndex: number,
  // When the level configures stop/limit prices the buy is a
  // STOP_LOSS_LIMIT that rests until price rises through the stop; omitted
  // keeps the level a MARKET buy. Prices are pre-rounded to tickSize by the
  // caller (grid-buy branch), which owns the market snapshot and filters.
  stopLimit?: { readonly stopPrice: string; readonly price: string },
): Decision => {
  const intent: OrderIntent = {
    symbol: input.market.symbol,
    side: 'BUY',
    reason: 'grid-buy',
    clientOrderId: gridBuyClientOrderId(input.profile.id, input.market.symbol, gridIndex),
    meta: { gridTradeIndex: gridIndex },
  };
  // A configured stop-limit level is a breakout-confirmation buy and is left a
  // STOP_LOSS_LIMIT regardless of execution mode. Otherwise maker entry mode
  // rests a passive LIMIT below the price; market mode (the default) keeps the
  // byte-identical MARKET shape. The `stopLimit ?` short-circuit just avoids a
  // wasted price computation — the params ternary below also lets stopLimit win.
  const makerLimit = stopLimit ? undefined : resolveMakerEntryLimit(input);
  const params: OrderParams = stopLimit
    ? {
        type: 'STOP_LOSS_LIMIT',
        quantity,
        price: stopLimit.price,
        stopPrice: stopLimit.stopPrice,
        timeInForce: 'GTC',
      }
    : makerLimit !== undefined
      ? { type: 'LIMIT', quantity, price: makerLimit, timeInForce: 'GTC' }
      : { type: 'MARKET', quantity };
  return { type: 'place-order', intent, params };
};

/**
 * Build the `place-order` Decision for a bull-pyramid strength-add. A plain
 * MARKET BUY in its own `bull-pyramid` reason + `pyr-<n>` clientOrderId
 * namespace so it never coalesces with a grid level. `addIndex` is the 1-based
 * add number; `quantity` MUST be filter-validated by the caller.
 */
export const buildPyramidBuyDecision = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  quantity: string,
  addIndex: number,
): Decision => {
  const intent: OrderIntent = {
    symbol: input.market.symbol,
    side: 'BUY',
    reason: 'bull-pyramid',
    clientOrderId: pyramidBuyClientOrderId(input.profile.id, input.market.symbol, addIndex),
    meta: { bullAddIndex: addIndex },
  };
  return { type: 'place-order', intent, params: { type: 'MARKET', quantity } };
};

/**
 * Build a `place-order` Decision for an operator-initiated manual order.
 *
 * The clientOrderId folds the API-stamped `overrideActionId` so a retry of
 * the same tick (same override row, same UUID) coalesces at Binance instead
 * of double-placing.
 *
 * `params.type` mirrors the operator's choice. LIMIT carries the typed
 * price and defaults `timeInForce: 'GTC'` because the manual flow has no
 * UI control for it and GTC is what an operator typing "buy at X" means.
 * MARKET sends just `quantity`; the executor will translate to a Binance
 * MARKET order with the computed base-asset quantity.
 *
 * `quantity` MUST be the filter-validated result of
 * {@link computeManualOrderQuantity}; this helper trusts the caller and
 * only assembles the Decision payload.
 */
export const buildManualOrderDecision = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  payload: ManualOrderRequest,
  quantity: string,
  overrideActionId: string,
): Decision => {
  // `reason` lands in `orders.intent`; `manual` is the
  // operator-initiated value.
  const intent: OrderIntent = {
    symbol: input.market.symbol,
    side: payload.side,
    reason: 'manual',
    clientOrderId: manualOrderClientOrderId(overrideActionId),
  };
  const params: OrderParams =
    payload.type === 'LIMIT'
      ? {
          type: 'LIMIT',
          quantity,
          // computeManualOrderQuantity rejects LIMIT without a price, so
          // by this point `payload.price` is a valid decimal string.
          price:
            /* v8 ignore next -- reason: LIMIT decisions are only built after computeManualOrderQuantity accepts a non-empty price, so the '0' fallback is unreachable */
            payload.price ?? '0',
          timeInForce: 'GTC',
        }
      : { type: 'MARKET', quantity };
  return { type: 'place-order', intent, params };
};

/**
 * Whether the open-order set already contains a foreign SELL for `symbol`;
 * gates strategy-initiated SELL emissions so a stop-loss or trailing-stop
 * doesn't race a manual sell already in flight.
 *
 * The strategy's OWN resting exchange-side protective stop is excluded: it is
 * strategy-managed (cancelled in the same batch ahead of any closing sell), so
 * counting it would freeze the in-process stop-loss the moment the protective
 * stop arms — defeating the backstop's primary path. `profileId` keys the
 * protective stop's deterministic clientOrderId so only that one order is
 * skipped; every other resting SELL still blocks.
 */
export const hasOpenSellForSymbol = (
  orders: readonly OpenOrder[],
  symbol: string,
  profileId: string,
): boolean => {
  const protectiveId = protectiveStopClientOrderId(profileId, symbol);
  return orders.some(
    (o) => o.symbol === symbol && o.side === 'SELL' && o.clientOrderId !== protectiveId,
  );
};

/**
 * Build the `place-order` Decision for a strategy-initiated SELL. The
 * market sell-side flavours (stop-loss, trailing-stop, manual sell) share the
 * same shape (MARKET SELL of `quantity` with a seed-hashed clientOrderId) and
 * differ only on intent.reason for audit labelling.
 *
 * `clientOrderIdSeed` is hashed into the clientOrderId so retries of the same
 * logical sell coalesce at Binance.
 *
 * `opts.stopLimit` switches the order to a resting STOP_LOSS_LIMIT SELL (the
 * offline protective stop): a stop trigger plus a limit price, GTC. When
 * omitted the MARKET shape is byte-identical to the pre-existing callers.
 * `opts.trailingDelta` switches it instead to a resting STOP_LOSS carrying only
 * a trailing distance — no trigger and no limit, because both would be banded —
 * which Binance triggers as a MARKET sell. The two are mutually exclusive;
 * `stopLimit` wins if both are somehow supplied.
 * `opts.clientOrderId` overrides the seed-hashed id for the protective stop,
 * which keys its resting order on a stable per-(profile, symbol) id instead.
 */
export const buildSellDecision = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  reason: Exclude<TTIntent, 'grid-buy'>,
  quantity: string,
  clientOrderIdSeed: string,
  opts?: {
    readonly stopLimit?: { readonly stopPrice: string; readonly price: string };
    readonly trailingDelta?: number;
    readonly clientOrderId?: string;
  },
): Decision => {
  const intent: OrderIntent = {
    symbol: input.market.symbol,
    side: 'SELL',
    reason,
    clientOrderId:
      opts?.clientOrderId ??
      sellClientOrderId(input.profile.id, input.market.symbol, clientOrderIdSeed),
  };
  let params: OrderParams;
  if (opts?.stopLimit) {
    params = {
      type: 'STOP_LOSS_LIMIT',
      quantity,
      price: opts.stopLimit.price,
      stopPrice: opts.stopLimit.stopPrice,
      timeInForce: 'GTC',
    };
  } else if (opts?.trailingDelta !== undefined) {
    // No timeInForce: a STOP_LOSS executes as a MARKET order on trigger, so
    // there is no resting limit for one to govern.
    params = { type: 'STOP_LOSS', quantity, trailingDelta: opts.trailingDelta };
  } else {
    params = { type: 'MARKET', quantity };
  }
  return { type: 'place-order', intent, params };
};

/** Build the `cancel-order` Decision that retracts a resting protective stop (superseded by a re-arm or about to be closed by a market sell). Carries the symbol so the executor can cancel even with no local order row. */
export const buildProtectiveStopCancel = (order: OpenOrder, reason: string): Decision => ({
  type: 'cancel-order',
  orderId: order.orderId,
  symbol: order.symbol,
  reason,
});

const sellClientOrderId = (profileId: string, symbol: string, seed: string): string =>
  // Tagged with seed so trailing-stop, stop-loss, and manual cycles get
  // distinct ids per logical sell, while a retry of the same tick (same seed,
  // same symbol) still coalesces at Binance. The shared length guard makes the
  // sell path match the buy builders instead of trusting the comment.
  assertClientOrderId(`tt-${djb2Hex(`${profileId}|${symbol}|${seed}`)}-s`);
