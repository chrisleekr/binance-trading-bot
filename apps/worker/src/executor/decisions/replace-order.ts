import { asProfileId, asUserId, isTerminalOrderStatus } from '@app/contracts';
import {
  BinanceApiError,
  OrderBudgetUnavailableError,
  type CancelReplaceCancelLeg,
  type CancelReplaceDto,
  type CancelReplaceParams,
  type OpenOrderDto,
  type PlaceOrderDto,
  type PlaceOrderParams,
} from '@app/binance';
import type { Decision, DecisionResult, ExecutorContext } from '@app/strategy-core';
import { classifyBinanceError } from 'executor/binance-error-taxonomy.js';
import { emitEvent } from 'executor/event-emitter.js';
import { readCurrentWeight, recordWeight } from 'executor/weight-limiter.js';
import { enqueueReconcile, resolveBindings, type DecisionDeps } from './_types.js';
import { evictCachedOpenOrder, executedSomething } from './cancel-order.js';
import {
  notifyClassifiedEmergency,
  recordPlacedOrder,
  refuseOnWeightThrottle,
  resolveAmbiguousPlacement,
} from './place-order.js';

/**
 * Binance's own record of the order this replacement retired, normalised across the three bodies that can carry it: the `cancelReplace` success body's `cancelResponse`, the cancel leg preserved on a `-2021` error, and the `getOrder` probe a `-2011` cancel leg forces.
 *
 * One shape because the local close asks one question of all three, and each spells the exchange clock differently (`transactTime` on the order bodies, `updateTime` on the probe). `raw` is the body verbatim — it is what overwrites the row's `raw`, so `executedQty` is truthful even when the status itself is not adopted.
 */
interface RetiredLeg {
  readonly status: string;
  /** Exchange clock for the retirement, `undefined` when the body carried none under either of its spellings. Not defaulted here: the close is the one place that decides what stamps a row with no exchange clock, and a second default beside it would be dominated by that one and silently untestable. */
  readonly atMs: number | undefined;
  /** How much of the retired order had executed, when the body said. Read out of `raw` rather than left to the reader because it decides whether a reconcile is owed, and a body that omits it is not evidence of zero. */
  readonly executedQty: string | undefined;
  readonly raw: unknown;
}

/** Successor shapes that mean this replacement RE-PRICES a protective stop rather than closing the position: the priced `STOP_LOSS_LIMIT` and the exchange-native trailing `STOP_LOSS`, both of which trailing-trade and momentum arm. Held here rather than inferred from the decision's `reason`, which is strategy vocabulary the executor must not read. */
const REARMED_STOP_TYPES: ReadonlySet<string> = new Set(['STOP_LOSS_LIMIT', 'STOP_LOSS']);

/** Execute Binance's atomic cancel-and-successor placement, with one recovery retry for a naked position.
 * @param deps - Shared worker dependencies for Binance, reconciliation, caching, and logging.
 * @param ctx - The executor identity used to resolve the profile bindings.
 * @param decision - The replacement order and the resting Binance order it supersedes.
 * @returns The replacement outcome, including any classified exchange failure.
 */
export const replaceOrderHandler = async (
  deps: DecisionDeps,
  ctx: ExecutorContext,
  decision: Extract<Decision, { type: 'replace-order' }>,
): Promise<DecisionResult> => {
  const userId = asUserId(ctx.userId);
  const profileId = asProfileId(ctx.profileId);
  const bindings = await resolveBindings(deps, userId, profileId);
  // The successor's own parameters, shared by the atomic request and the bare re-place after -2021 so the two cannot drift.
  const successorParams: PlaceOrderParams = {
    symbol: decision.intent.symbol,
    side: decision.intent.side,
    type: decision.params.type,
    quantity: decision.params.quantity,
    newClientOrderId: decision.intent.clientOrderId,
    ...(decision.params.price !== undefined ? { price: decision.params.price } : {}),
    ...(decision.params.stopPrice !== undefined ? { stopPrice: decision.params.stopPrice } : {}),
    ...(decision.params.trailingDelta !== undefined
      ? { trailingDelta: decision.params.trailingDelta }
      : {}),
    ...(decision.params.timeInForce !== undefined
      ? { timeInForce: decision.params.timeInForce }
      : {}),
  };
  const orderParams: CancelReplaceParams = {
    ...successorParams,
    cancelOrderId: decision.cancelOrderId,
  };

  // Everything that must happen once the resting leg is gone at Binance, in one routine so no path can retire an order at the exchange and leave the local view of it open. The local row is closed by `cancelOrderId` rather than left to the successor's live-slot upsert: the successor's intent need not match the retired order's, and a terminal successor (a MARKET exit that filled) never reaches that upsert at all, so either would strand a permanently-open row.
  //
  // `leg` is Binance's own record of the retired order, whenever one is readable. Its body ALWAYS reaches the row's `raw`, so a stop that moved base before it left the book carries its real `executedQty` instead of the placement-time zero — which is what makes `resolveOrderSlot`'s remaining quantity and the symbol page truthful, and nothing rewrites that field afterwards because a partially-filled-then-cancelled order never emits a FILLED execution report; the reconcile below repairs the POSITION, never this row. Its STATUS is adopted only when terminal: `closeOrder` stamps `closed_at` unconditionally, and the repo invariant is that only a terminal row carries one, so a non-terminal reading falls back to a plain CANCELED at the worker clock rather than closing an order that is somehow still resting. That fallback is a defensive read, not a shape Binance is expected to send. Paths that reach here with no readable body fall back the same way, and so does a body that IS terminal but carried no exchange clock under either of its spellings — this is the one place that decides what stamps such a row, so the normaliser below reports absence instead of defaulting alongside it.
  //
  // Whichever status the row ends up carrying is also the one the `orders` event publishes, because the operator watching the symbol page is being told what happened to THIS order — a leg that filled and a leg that cancelled are opposite facts, and a hard-coded CANCELED would report "nothing sold" at the moment the position was sold.
  //
  // A leg whose `executedQty` moved schedules a reconcile from here rather than from any one caller, so no path can retire an order that sold base and leave the strategy's `heldQuantity` and the avg-entry ledger overstated. The stream cannot repair it: `fill-adopter` ignores every execution report whose order status is not FILLED, so the PARTIALLY_FILLED reports are dropped and the trailing CANCELED one carries no adoption. The cause is `cancel-2011-fill`, the label the standalone cancel path already stamps on the identical discovery — one repair, one name, rather than a second cause for the same drift.
  const reportCancelledLeg = async (leg?: RetiredLeg): Promise<void> => {
    await evictCachedOpenOrder(deps, decision.intent.symbol, decision.cancelOrderId);
    const adopted = leg !== undefined && isTerminalOrderStatus(leg.status) ? leg : undefined;
    const status = adopted?.status ?? 'CANCELED';
    try {
      await bindings.persistence.closeOrder(
        decision.cancelOrderId,
        status,
        adopted?.atMs ?? deps.clock.nowMs(),
        leg?.raw,
      );
    } catch (err) {
      deps.logger.warn(
        { profileId, orderId: decision.cancelOrderId, err },
        'replace-order: could not close the cancelled leg locally',
      );
    }
    try {
      await emitEvent(deps, deps.accountId, profileId, 'orders', {
        orderId: decision.cancelOrderId,
        status,
        reason: decision.reason,
      });
    } catch (err) {
      deps.logger.warn(
        { profileId, orderId: decision.cancelOrderId, err },
        'replace-order: could not emit the cancelled leg event',
      );
    }
    if (leg !== undefined && executedSomething(leg.executedQty)) {
      await enqueueReconcile(deps, profileId, decision.intent.symbol, 'cancel-2011-fill', {
        orderId: decision.cancelOrderId,
      });
    }
  };

  const markUnresolved = async (): Promise<void> => {
    const resolved = await bindings.persistence
      .resolveOrderSlot(decision.cancelOrderId)
      .catch(() => null);
    deps.cancelLedger.markUnresolved(decision.intent.symbol, resolved?.intent);
  };

  // The one normaliser all three bodies go through, so the close reads a single shape rather than each path spelling the same fields out for itself. The exchange clock is read under both spellings — `transactTime` on the two order bodies, `updateTime` on the probe — and reports absence rather than substituting anything, because the close above already owns the worker-clock fallback for the bodies it never gets at all. Every field is type-tested rather than trusted because all three bodies are CASTS of a parsed response, not validated values.
  const asRetiredLeg = (leg: {
    readonly status: string;
    readonly transactTime?: unknown;
    readonly updateTime?: unknown;
    readonly executedQty?: unknown;
  }): RetiredLeg => ({
    status: leg.status,
    atMs:
      typeof leg.transactTime === 'number'
        ? leg.transactTime
        : typeof leg.updateTime === 'number'
          ? leg.updateTime
          : undefined,
    executedQty: typeof leg.executedQty === 'string' ? leg.executedQty : undefined,
    raw: leg,
  });

  // Ask the exchange what actually became of the resting order — the one question a `-2011` cancel leg cannot answer for itself. `null` means we did not learn, and every caller must then fail closed. That includes a probe refused with `-2013 NO_SUCH_ORDER`, which IS positive proof of absence and could in principle drive the retirement repair. Leaving it on the fail-closed path is a deliberate call rather than an unhandled case: the two mistakes are not symmetric — withholding an exit costs one tick and the next one retries it, while re-placing behind an order that turns out to be still resting puts a second live sell against the same base.
  const probeRetiredLeg = async (): Promise<OpenOrderDto | null> => {
    let order: OpenOrderDto;
    try {
      order = await bindings.binance.getOrder({
        symbol: decision.intent.symbol,
        orderId: decision.cancelOrderId,
      });
    } catch (probeErr) {
      deps.logger.warn(
        {
          profileId,
          symbol: decision.intent.symbol,
          orderId: decision.cancelOrderId,
          err: probeErr,
        },
        'replace-order: could not probe the -2011 cancel leg; treating the resting order as still on the book',
      );
      return null;
    }
    try {
      await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
    } catch (weightErr) {
      deps.logger.warn(
        { profileId, err: weightErr },
        'replace-order: could not record request weight after the -2011 probe',
      );
    }
    return order;
  };

  // The recovery shared by every failure in which Binance has already retired the resting order while the successor never reached the matching engine. An explicit `-2021` says so directly. A `-2022` whose cancel leg is `-2011` says it only once the exchange has been asked which of that code's two meanings applied and answered with a terminal status that is not a fill. Identical state, therefore identical repair — one bare re-place of the same successor — rather than leaving one of them to re-emit against a phantom order every tick until the open-orders cache expires. `retiredBy` names which arrived, for the operator reading the refusal; `leg` is Binance's record of the retired order where the path could recover one.
  const retireAndRePlaceSuccessor = async (
    retiredBy: string,
    leg?: RetiredLeg,
  ): Promise<DecisionResult> => {
    await reportCancelledLeg(leg);
    // Stamp this profile again before the bare retry, because the retry transmits the same successor id and can publish its report before persistence catches up.
    await deps.placementOwner?.register(deps.accountId, profileId, decision.intent.clientOrderId);
    // Still needed by the ambiguous-placement resolver below, which dates the successor attempt.
    const calledAtMs = deps.clock.nowMs();
    let retryDto: PlaceOrderDto;
    try {
      retryDto = await bindings.binance.placeOrder(successorParams);
    } catch (retryErr) {
      try {
        await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
      } catch (weightErr) {
        deps.logger.warn(
          { profileId, err: weightErr },
          'replace-order: could not record request weight after successor retry failed',
        );
      }
      deps.logger.warn(
        // `unsoldExit` reads the one thing the executor can tell without knowing any strategy's vocabulary: a MARKET successor is a terminal exit, so the position is ALSO still held, not merely unprotected.
        {
          profileId,
          symbol: decision.intent.symbol,
          retiredBy,
          unsoldExit: decision.params.type === 'MARKET',
          err: retryErr,
        },
        'replace-order: successor retried once and failed; the resting order is gone and nothing replaced it — for a MARKET successor the position is also still held and unsold',
      );
      if (retryErr instanceof OrderBudgetUnavailableError) {
        await enqueueReconcile(deps, profileId, decision.intent.symbol, 'replace-order-failed', {
          retry: true,
        });
        return {
          ok: false,
          retryable: true,
          phase: 'pre-call',
          reason: `cancelReplace: naked after ${retiredBy}, order budget exhausted window=${retryErr.windowMs}ms`,
        };
      }
      if (!(retryErr instanceof BinanceApiError)) {
        await enqueueReconcile(deps, profileId, decision.intent.symbol, 'replace-order-failed', {
          retry: true,
        });
        return resolveAmbiguousPlacement(
          deps,
          bindings,
          ctx,
          { type: 'place-order', intent: decision.intent, params: decision.params },
          calledAtMs,
          retryErr as Error,
        );
      }
      const classified = classifyBinanceError(retryErr);
      await notifyClassifiedEmergency(deps, bindings, profileId, decision, retryErr, classified);
      if (classified.result.ok) {
        await enqueueReconcile(deps, profileId, decision.intent.symbol, 'replace-order-failed', {
          reason: 'retry-classified-ok',
        });
        return {
          ok: false,
          retryable: false,
          phase: 'accepted',
          reason: `cancelReplace: naked after ${retiredBy}, re-place reported an existing order`,
        };
      }
      await enqueueReconcile(deps, profileId, decision.intent.symbol, 'replace-order-failed', {
        retry: true,
      });
      return {
        ...classified.result,
        cause: retryErr,
        reason: `cancelReplace: naked after ${retiredBy}, re-place failed: ${classified.result.reason}`,
      };
    }
    try {
      await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
    } catch (weightErr) {
      deps.logger.warn(
        { profileId, err: weightErr },
        'replace-order: could not record request weight after successor retry',
      );
    }
    return recordPlacedOrder(deps, ctx, bindings, decision.intent, decision.params, retryDto);
  };

  const weightRefusal = await refuseOnWeightThrottle(
    deps,
    bindings,
    profileId,
    decision,
    await readCurrentWeight(deps, deps.accountId, profileId),
  );
  if (weightRefusal !== null) {
    return decision.intent.deferrable === true
      ? { ...weightRefusal, deferred: true }
      : weightRefusal;
  }

  // A SELL successor that is not itself a stop is a CLOSE, and the duplicate-MARKET guard (executor/placement-dedup) keys re-entry suppression on the exit having been seen. Entry clientOrderIds are stable per (profile, symbol, level), so a grid promotion or pyramid add recorded WHILE the stop rested would suppress a legitimate re-entry at that level for the rest of the window unless the close clears the symbol. The exclusion is the two stop shapes a strategy RE-ARMS — a re-price closes nothing, and clearing on one would drop exactly the records the guard exists to hold. Everything else is a close and clears, which is what `place-order` does for any SELL: an operator's manual close is a LIMIT whenever they asked for a price, and narrowing this to MARKET would silently stop clearing for it.
  if (decision.intent.side === 'SELL' && !REARMED_STOP_TYPES.has(decision.params.type)) {
    await deps.placementDedup?.forgetSymbol(
      `${deps.accountId}:${decision.intent.symbol}`,
      deps.clock.nowMs(),
    );
  }

  let dto: CancelReplaceDto;
  // Stamp this profile before cancelReplace transmits the successor, because Binance can publish its execution report before the successor row exists and the marker is the only ownership evidence in that gap.
  await deps.placementOwner?.register(deps.accountId, profileId, decision.intent.clientOrderId);
  try {
    dto = await bindings.binance.cancelReplaceOrder(orderParams);
  } catch (err) {
    try {
      await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
    } catch (weightErr) {
      deps.logger.warn(
        { profileId, err: weightErr },
        'replace-order: could not record request weight after cancelReplace failed',
      );
    }
    if (err instanceof OrderBudgetUnavailableError) {
      return {
        ok: false,
        retryable: true,
        phase: 'pre-call',
        ...(decision.intent.deferrable === true ? { deferred: true as const } : {}),
        reason: `order-budget-exhausted window=${err.windowMs}ms wait=${err.waitMs}ms`,
      };
    }
    if (!(err instanceof BinanceApiError)) {
      await markUnresolved();
      await enqueueReconcile(deps, profileId, decision.intent.symbol, 'replace-order-failed', {
        reason: 'transport-failure',
      });
      return {
        ok: false,
        retryable: true,
        phase: 'ambiguous',
        reason: `cancelReplace: transport failure: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (err.code === -2022) {
      // `-2011` is CANCEL_REJECTED, not absence (`-2013` is absence), so a cancel leg carrying it collapses two OPPOSITE states: a concurrent cancel already took the order off the book, or the order FILLED — the likelier one here, because the same gap-down that triggers a fused close is what trips the stop. The leg carries no status, and guessing costs money in both directions: stamping a filled stop CANCELED hides a real trade from realised P/L forever (the archive selects `status = 'FILLED'`), and re-placing a MARKET exit behind a stop that already sold is a SECOND sale, fundable from a sibling profile's base on the shared account wallet. So ask the exchange, exactly as the standalone cancel path does for the same code.
      if (err.cancelLegCode === -2011) {
        const probed = await probeRetiredLeg();
        // `isTerminalOrderStatus`, not a local set: the same predicate `reportCancelledLeg` uses eight lines above to decide whether the row may be stamped closed. Two vocabularies here answered one question two ways — the shared contract counts `EXPIRED_IN_MATCH` (self-trade prevention, which is exactly what a sibling profile's BUY crossing our resting SELL on the shared account wallet produces) as gone, a four-member local set called it still resting, and the exit was withheld every tick for an order that provably was not there.
        if (probed !== null && isTerminalOrderStatus(probed.status)) {
          const leg = asRetiredLeg(probed);
          if (probed.status === 'FILLED' && executedSomething(probed.executedQty)) {
            // The stop sold the whole position. Record what actually happened — `reportCancelledLeg` hands the position to the reconciler on the way, because adopting inline would self-await this symbol's chain lock, which the fill-adopter also takes — and WITHHOLD the successor: there is nothing left to sell. A leg that moved base under any OTHER terminal status is a PARTIAL that was then retired, so it still leaves base to sell and falls through to the re-place below with its reconcile already scheduled.
            await reportCancelledLeg(leg);
            return {
              ok: false,
              // `rejected` because STOP_ON_FAILURE is Binance's proof the successor never reached the matching engine, so the tick must not commit a state computed on the assumption it landed. NOT retryable: re-issuing would cancel an order that is already gone and sell base this profile no longer holds. The reconcile is the repair, and settling an operator override as rejected is correct here — the sell it wanted has effectively happened.
              retryable: false,
              phase: 'rejected',
              reason: `cancelReplace: the resting order filled rather than cancelling (${err.code}/-2011); successor withheld, position handed to reconcile`,
            };
          }
          return retireAndRePlaceSuccessor('-2022/-2011', leg);
        }
        // The probe failed, or answered with a status that is still on the book. Fall through to the ordinary refusal — nothing is retired locally, and nothing new goes on the book.
        deps.logger.warn(
          {
            profileId,
            symbol: decision.intent.symbol,
            orderId: decision.cancelOrderId,
            probed: probed?.status,
          },
          'replace-order: -2011 cancel leg could not be resolved to a terminal state; refusing as an ordinary -2022',
        );
      }
      await markUnresolved();
      await enqueueReconcile(deps, profileId, decision.intent.symbol, 'replace-order-failed', {
        code: err.code,
      });
      return {
        ok: false,
        // Binance reports `newOrderResult: NOT_ATTEMPTED` under STOP_ON_FAILURE, which is positive proof the successor never reached the matching engine, so re-issuing the whole decision cannot double-place. Retryable is also what keeps an operator override riding this SELL re-armed rather than settled `rejected` and silently abandoned; `applyAll` still breaks the chain on this tick either way.
        retryable: true,
        phase: err.phase,
        reason: `cancelReplace: cancel refused ${err.code}: ${err.msg}`,
        cause: err,
      };
    }

    // Under STOP_ON_FAILURE a `-2021` means the cancel SUCCEEDED, so the error's cancel leg is Binance's full record of the order it just retired — status, exchange clock, executed quantity — not an error shape. Passing it through is what stops a partially-filled stop being archived as a worker-clocked CANCELED with the placement-time zero.
    if (err.code === -2021)
      return retireAndRePlaceSuccessor(
        '-2021',
        err.cancelLeg === undefined ? undefined : asRetiredLeg(err.cancelLeg),
      );

    const classified = classifyBinanceError(err);
    if (err.phase === 'ambiguous') {
      await markUnresolved();
      await enqueueReconcile(deps, profileId, decision.intent.symbol, 'replace-order-failed', {});
      if (classified.result.ok) {
        return {
          ok: false,
          retryable: false,
          phase: 'accepted',
          reason: 'cancelReplace: classified ok without a successor body',
        };
      }
      return { ...classified.result, cause: err };
    }
    await notifyClassifiedEmergency(deps, bindings, profileId, decision, err, classified);
    if (classified.result.ok) {
      await enqueueReconcile(deps, profileId, decision.intent.symbol, 'replace-order-failed', {
        reason: 'classified-ok',
      });
      return {
        ok: false,
        retryable: false,
        phase: 'accepted',
        reason: 'cancelReplace: classified ok without a successor body',
      };
    }
    return { ...classified.result, cause: err };
  }
  try {
    await recordWeight(deps, deps.accountId, profileId, bindings.binance.ctx().weightUsed1m);
  } catch (err) {
    deps.logger.warn(
      { profileId, err },
      'replace-order: could not record request weight after successful cancelReplace',
    );
  }
  // Binance's own record of the retired order. The union also admits an error shape and `null`; only the cancel DTO carries a string `status`, so a STRING there is what distinguishes them — the same narrowing the transport applies when it decides whether an error body's cancel leg is an order or a refusal. A key test would not be enough: `dto` is a CAST of the parsed body rather than a validated value, so a non-string `status` would reach `isTerminalOrderStatus`, whose `toUpperCase` throws — outside every `try` on this path, after Binance has already cancelled the stop and placed its successor, and before the successor's row is written. The optional chain covers the same read for a body with no `cancelResponse` at all, which reads as `undefined`. The successor check below is symmetric for the same reason.
  const cancelLeg = dto.cancelResponse as { readonly status?: unknown } | null | undefined;
  await reportCancelledLeg(
    typeof cancelLeg?.status === 'string'
      ? asRetiredLeg(cancelLeg as unknown as CancelReplaceCancelLeg)
      : undefined,
  );
  const successor = dto.newOrderResponse;
  if (
    successor === null ||
    typeof successor !== 'object' ||
    typeof (successor as { readonly orderId?: unknown }).orderId !== 'number'
  ) {
    await enqueueReconcile(deps, profileId, decision.intent.symbol, 'replace-order-failed', {
      reason: 'no-successor-order-id',
    });
    return {
      ok: false,
      retryable: false,
      phase: 'accepted',
      reason: 'cancelReplace: SUCCESS without a new order body',
    };
  }
  return recordPlacedOrder(
    deps,
    ctx,
    bindings,
    decision.intent,
    decision.params,
    successor as PlaceOrderDto,
  );
};
