import type { ZodType } from 'zod';
import type { StrategyEventMap } from './contract.js';
import type { OrderSide, OrderType, TimeInForce } from './contract.js';

export interface OrderIntent {
  readonly symbol: string;
  readonly side: OrderSide;
  /**
   * Why the order was placed. A strategy-owned, namespaced string that
   * lands in `orders.intent`; the core contract does not constrain its
   * vocabulary (each strategy defines its own intents and the column has
   * no CHECK). Drives operator-facing labels and audit/notify hooks.
   */
  readonly reason: string;
  readonly clientOrderId: string;
  /**
   * Strategy-owned metadata for this order, persisted opaquely to the
   * `orders.meta` jsonb column. Lets a strategy tag an order with its own
   * fields (TT writes `{ gridTradeIndex }`) without the core schema naming
   * any strategy concept. Omitted for orders that carry no metadata; the
   * column is nullable so omission round-trips cleanly.
   */
  readonly meta?: Record<string, unknown>;
  /**
   * The operator override this order exists to carry out, when it has one.
   * Absent on every strategy-initiated order.
   *
   * The worker settles an override on the ORDER'S outcome, not on the
   * strategy's intent to act, and the only sound way to correlate a dropped or
   * failed order back to the override that caused it is for the order to carry
   * the id. Guessing ("a BUY was suppressed, probably the override's") settles
   * the wrong row the moment a tick emits an unrelated order. The field is a
   * plain string so the core contract stays free of any strategy's override
   * vocabulary.
   */
  readonly overrideActionId?: string;
  /**
   * This order is an IMPROVEMENT, not a necessity: when the account's Binance
   * order budget has no headroom, the executor skips it for this tick instead
   * of waiting for headroom. Waiting would hold the per-(profile, symbol) chain
   * lock, delaying the next tick's exit check — worse than a late reprice.
   *
   * Set it only when the order's absence leaves the position no less protected
   * than it already is: re-pricing a resting protective stop qualifies, because
   * the existing stop stays live. An exit, an entry, or the FIRST arming of a
   * stop must never set it — those are the orders a shed would turn into a
   * loss. Absent (the default) means block-and-wait.
   *
   * Generic on purpose: the executor decides shed-vs-block from this flag, not
   * from `reason`, so it never has to know a strategy's intent vocabulary.
   */
  readonly deferrable?: boolean;
}

export interface OrderParams {
  readonly type: OrderType;
  readonly price?: string;
  readonly stopPrice?: string;
  readonly quantity: string;
  /**
   * Exchange-native trailing distance in basis points, for a `STOP_LOSS` that
   * carries NO `stopPrice`: Binance then tracks the high-water mark itself and
   * triggers a MARKET sell this far below it.
   *
   * The one order param that is a `number` rather than a decimal-string, and
   * deliberately so — the money-math rule binds prices, quantities and amounts.
   * Binance types `trailingDelta` as a `LONG`, and it is a RATIO, not a price:
   * there is no sub-unit precision to lose and nothing here is ever summed
   * against money.
   */
  readonly trailingDelta?: number;
  readonly timeInForce?: TimeInForce;
}

type EventPayload<S> = S extends { readonly payload: ZodType<infer Out> } ? Out : never;

/**
 * Generic over the emitting strategy's event map. `emit-event.eventType`
 * is a key of the map and `payload` is the zod-inferred shape of the
 * matching schema, so a strategy that ships its event map gets tsc
 * enforcement on every emit site without a runtime parse.
 *
 * Defaulting `E` to {@link StrategyEventMap} keeps the un-parameterised
 * `Decision` type usable in executor / replay code that does not need to
 * know the producer's event vocabulary.
 */
export type Decision<E extends StrategyEventMap = StrategyEventMap> =
  | { readonly type: 'noop' }
  | { readonly type: 'place-order'; readonly intent: OrderIntent; readonly params: OrderParams }
  | {
      readonly type: 'cancel-order';
      readonly orderId: number;
      readonly reason: string;
      /**
       * The order's trading pair, when the strategy knows it. Lets the
       * executor cancel on the exchange even when no local `orders` row
       * exists yet (a fill the worker placed but never persisted). Omitted
       * by emit sites that have no symbol to hand; the executor then falls
       * back to resolving the symbol from the local row.
       */
      readonly symbol?: string;
    }
  | {
      [K in keyof E & string]: {
        readonly type: 'emit-event';
        readonly eventType: K;
        readonly payload: EventPayload<E[K]>;
      };
    }[keyof E & string]
  // Cross-symbol scratchpad. A strategy trading several symbols on
  // one profile gets one `tick()` slice per symbol, so it cannot read a sibling
  // symbol's state directly. These two variants let a tick publish a fact under a
  // strategy-owned namespaced key into a PER-PROFILE (not per-symbol) store; every
  // symbol's later ticks read the merged snapshot via `TickInput.profileKv`. The
  // value is JSON-serialisable and opaque to the executor. Concurrent sibling
  // ticks are last-writer-wins per key (eventual, like the rest of the contract);
  // a strategy republishes its slice each tick.
  | { readonly type: 'set-kv'; readonly key: string; readonly value: unknown }
  | { readonly type: 'delete-kv'; readonly key: string };
