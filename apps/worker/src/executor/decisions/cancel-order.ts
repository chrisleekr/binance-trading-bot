import type { Decision, DecisionResult, ExecutorContext } from '@app/strategy-core';
import { asProfileId, asUserId } from '@app/contracts';
import { BinanceApiError } from '@app/binance';
import { classifyBinanceError } from 'executor/binance-error-taxonomy.js';
import { emitEvent } from 'executor/event-emitter.js';
import { Decimal, isPlainDecimalString } from '@app/money';
import { baseAssetOf } from 'executor/fundable.js';
import { buildOpenOrdersKey } from 'executor/redis-namespace.js';
import { removeOpenOrder } from 'executor/open-orders-cache.js';
import { recordWeight } from 'executor/weight-limiter.js';
import { enqueueReconcile, resolveBindings, type DecisionDeps } from './_types.js';
import { errorMessage } from '@app/core/error';

/** Quote handed back by a cancelled BUY: what is left of it, at the price it rested at. */
const quoteReleased = (remainingQty: string | null, price: string | null): string | null => {
  if (remainingQty === null || price === null) return null;
  if (!isPlainDecimalString(remainingQty) || !isPlainDecimalString(price)) return null;
  return new Decimal(remainingQty).times(new Decimal(price)).toString();
};

// Binance order states that mean the order has left the book for good. The
// -2011 cancel-vs-fill reconciliation closes the local row only on one of
// these; anything else (NEW / PARTIALLY_FILLED / PENDING_CANCEL) is still live
// and must not be stamped closed.
const TERMINAL_STATUSES = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED']);

/**
 * Did this order actually move base quantity? A FILLED status with a zero (or
 * unparseable) executedQty moved nothing, so there is no fill to adopt and no
 * position to repair. `Decimal`, not `Number`: executedQty is money-domain and
 * the comparison must not go through IEEE-754.
 */
const executedSomething = (executedQty: string | undefined): boolean => {
  if (executedQty === undefined) return false;
  try {
    return new Decimal(executedQty).gt(0);
  } catch {
    return false;
  }
};

/**
 * Drop the just-cancelled order from the shared open-orders snapshot in place
 * (instead of DELeting the whole key), so a sibling profile's next tick reads the
 * updated list without a REST cold-load. Best-effort: a cache-write failure must
 * not fail a cancel that already cleared the exchange — the TTL cold-load
 * self-heals. Both the clean-cancel and the -2011 reconcile path call this.
 */
const evictCachedOpenOrder = async (
  deps: DecisionDeps,
  symbol: string,
  orderId: number,
): Promise<void> => {
  try {
    await removeOpenOrder(deps.redis, buildOpenOrdersKey(deps.accountId, symbol), orderId);
  } catch (err) {
    deps.logger?.warn(
      { orderId, symbol, err: err },
      'cancel-order: open-orders cache eviction failed; next tick cold-loads',
    );
  }
};

/**
 * `cancel-order` translates a `(orderId, reason)` decision into a Binance
 * cancel + bookkeeping. Two non-obvious behaviours preserved from the
 * pre-split executor:
 *
 *  - Symbol resolution. The decision may carry `symbol` directly (the
 *    strategy knew it at emit time); otherwise
 *    `bindings.persistence.resolveOrderSlot` reads the `orders` table.
 *    Only when BOTH are absent do we refuse the cancel as non-retryable —
 *    an order the worker placed but never persisted (a bookkeeping crash)
 *    must still be cancellable on the exchange, so a local-row miss alone
 *    is not a refusal. The local close stays best-effort.
 *  - `-2011 ORDER_NOT_EXIST` is success, not failure. Binance returns it
 *    when the order is already cancelled (race with a fill or a previous
 *    cancel); the local order row is closed and the cancelled event is
 *    emitted so the SPA sees the same UI state regardless of who won the
 *    race.
 */
export const cancelOrderHandler = async (
  deps: DecisionDeps,
  ctx: ExecutorContext,
  decision: Extract<Decision, { type: 'cancel-order' }>,
): Promise<DecisionResult> => {
  const userId = asUserId(ctx.userId);
  const profileId = asProfileId(ctx.profileId);
  const bindings = await resolveBindings(deps, userId, profileId);

  // The local row gives the symbol, the live SLOT (symbol, intent) this cancel
  // would free, and what the order is holding. Read once, lazily: the happy path
  // with a symbol on the decision needs no local row at all, and only a FAILED
  // cancel needs the intent.
  type Slot = Awaited<ReturnType<typeof bindings.persistence.resolveOrderSlot>>;
  let slot: Slot | undefined;
  const loadSlot = async (): Promise<Slot> =>
    slot !== undefined
      ? slot
      : (slot = await bindings.persistence.resolveOrderSlot(decision.orderId));

  const symbol = decision.symbol ?? (await loadSlot())?.symbol;
  if (!symbol) {
    // Nothing was ever sent to Binance: there is no order to cancel locally.
    return {
      ok: false,
      retryable: false,
      phase: 'pre-call',
      reason: `order ${decision.orderId} not found locally`,
    };
  }

  // The cancel did not land (or we cannot prove it did), so the order may still be
  // RESTING. Record the slot it is holding, so a later place on that slot cannot
  // stamp its row CANCELED. A slot we cannot resolve fails the whole SYMBOL closed:
  // we cannot tell which slot is left holding a live order. Never let this bookkeeping
  // throw over the real failure — a resolve error means "unknown slot", which is
  // exactly the fail-closed case.
  const markUnresolved = async (): Promise<void> => {
    const resolved = await loadSlot().catch(() => null);
    deps.cancelLedger.markUnresolved(symbol, resolved?.intent);
  };

  /**
   * The cancel provably cleared the exchange, so whatever the order was holding is
   * back in the wallet NOW — but the cached balance snapshot will not say so until
   * the user stream catches up. Credit it to the batch so the next decision (the
   * replacement stop, or the exit SELL that follows a cancel of that same stop) is
   * judged against the real wallet instead of being vetoed as unfundable.
   *
   * A cancel whose local row cannot be read released an UNKNOWN amount — recorded
   * as such, which makes the funding check decline to judge that asset rather than
   * judge it wrongly.
   */
  const markReleased = async (): Promise<void> => {
    const resolved = await loadSlot().catch(() => null);
    // A SELL locks BASE, a BUY locks QUOTE, and both sides run the same
    // cancel-then-place shape in one decision array: momentum's exit cancels its
    // resting stop before the SELL, and trailing-trade's grid cancels its stale
    // resting BUYs before the replacement BUY. Crediting only the base would leave
    // the quote side judged against the same stale snapshot — the grid entry dropped
    // as "unfundable" while its own cancelled BUY held the cash.
    const side = resolved?.side ?? null;
    const base = baseAssetOf(symbol, bindings.quoteAsset);
    if (side === null) {
      // The local row could not be read, so we do not even know WHICH asset came back.
      // Crediting the base by default would leave a cancelled BUY's quote uncredited —
      // and a replacement BUY in the same batch vetoed as unfundable. Poison BOTH
      // candidates instead: the funding check then declines to judge either, which is
      // the ledger's stated policy for an unquantifiable release.
      deps.cancelLedger.markReleased(bindings.quoteAsset, null);
      if (base !== null) deps.cancelLedger.markReleased(base, null);
      return;
    }
    const asset = side === 'BUY' ? bindings.quoteAsset : base;
    if (asset === null) return;
    // Quote released = remaining quantity x limit price. A missing price (an ACK-shape
    // row, or a MARKET order that never locked quote as a resting order anyway) makes
    // the amount unknowable — `null`, which fails the funding check OPEN rather than
    // crediting a silent zero and vetoing a fundable order.
    const released =
      side === 'BUY'
        ? quoteReleased(resolved?.remainingQty ?? null, resolved?.price ?? null)
        : (resolved?.remainingQty ?? null);
    deps.cancelLedger.markReleased(asset, released);
  };
  try {
    const dto = await bindings.binance.cancelOrder({ symbol, orderId: decision.orderId });
    await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
    await markReleased();
    await bindings.persistence.closeOrder(decision.orderId, dto.status, dto.transactTime);
    await evictCachedOpenOrder(deps, symbol, decision.orderId);
    await emitEvent(deps, deps.accountId, profileId, 'orders', {
      orderId: decision.orderId,
      status: dto.status,
      reason: decision.reason,
    });
    return { ok: true };
  } catch (err) {
    await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
    if (err instanceof BinanceApiError && err.code === -2011) {
      // -2011 (order not on the book) races EITHER a concurrent cancel OR a
      // fill. The cancel response carries no status, so guessing CANCELED
      // mis-records a filled order as canceled (executedQty 0) — the operator
      // then sees coins in the wallet no order explains. Query the order's
      // authoritative terminal state and stamp that, with the fresh snapshot as
      // `raw` so executedQty is truthful. If the query itself fails, fall back to
      // the old CANCELED stamp with the injected clock and log the ambiguity.
      //
      // This probe is often the ONLY place the fill is ever seen. The user stream
      // is not a guarantee: it can be silent, half-dead, or reconnecting, and
      // Binance never replays events from before a resubscribe. So a FILLED probe
      // must also drive the POSITION, not just the order row — otherwise the
      // strategy keeps a heldQuantity it no longer owns. Adoption is deferred to
      // the `symbol-reconcile` queue rather than done here: this code runs inside
      // the tick's per-(profile, symbol) chain lock, which the fill-adopter also
      // takes, so an inline adopt would self-await and hang the tick forever.
      let status = 'CANCELED';
      let closedAtMs = deps.clock.nowMs();
      let raw: unknown;
      try {
        const order = await bindings.binance.getOrder({ symbol, orderId: decision.orderId });
        await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
        // Only adopt the queried status when it is terminal. Closing the row
        // stamps closed_at, and the repo invariant is that only terminal rows
        // carry it. A non-terminal (NEW / PARTIALLY_FILLED) or malformed
        // (undefined) status keeps the CANCELED fallback rather than closing a
        // still-resting order mid-flight.
        if (TERMINAL_STATUSES.has(order.status)) {
          status = order.status;
          closedAtMs = order.updateTime;
          raw = order;
          if (order.status === 'FILLED' && executedSomething(order.executedQty)) {
            await enqueueReconcile(deps, profileId, symbol, 'cancel-2011-fill', {
              orderId: decision.orderId,
            });
          }
        } else {
          deps.logger?.warn(
            { userId, profileId, orderId: decision.orderId, queried: order.status },
            'cancel -2011: queried order is not terminal; recording CANCELED',
          );
        }
      } catch (queryErr) {
        deps.logger?.warn(
          {
            userId,
            profileId,
            orderId: decision.orderId,
            err: queryErr,
          },
          'cancel -2011: order-status query failed; recording CANCELED (status ambiguous)',
        );
      }
      // The order is off the book either way (cancelled earlier, or filled), so
      // whatever it was holding is no longer locked by it — same credit as a clean
      // cancel. A FILLED order released the base by SELLING it, so the credit can
      // overstate free; that only ever lets an order through to Binance, which is
      // the authority, and never blocks a real one.
      await markReleased();
      await bindings.persistence.closeOrder(decision.orderId, status, closedAtMs, raw);
      await evictCachedOpenOrder(deps, symbol, decision.orderId);
      await emitEvent(deps, deps.accountId, profileId, 'orders', {
        orderId: decision.orderId,
        status,
        reason: decision.reason,
      });
      return { ok: true };
    }
    await markUnresolved();
    if (!(err instanceof BinanceApiError)) {
      return {
        ok: false,
        retryable: true,
        // No response came back, which says nothing about whether Binance
        // processed the cancel. Treat it as unresolved, not as a clean refusal.
        phase: 'ambiguous',
        reason: `cancel failed: ${errorMessage(err)}`,
        cause: err,
      };
    }
    return classifyBinanceError(err).result;
  }
};
