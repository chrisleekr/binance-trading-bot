import { log, metric } from '@app/strategy-core';
import type { Decision, TickInput, TickOutput } from '@app/strategy-core';
import { buildManualOrderDecision, buildSellDecision } from '../decisions.js';
import {
  computeManualOrderQuantity,
  computeSellQuantity,
  type SellSkipReason,
} from '../quantity.js';
import type { TTBundle, TTConfig, TTState } from '../schema.js';
import { clearedSellPosition } from '../position-lifecycle.js';
import { armAutoTriggerBuy, emitForcedFirstEntry } from './first-entry.js';
import { protectiveStopCancelDecisions } from './protective-stop.js';
import { reclaimableOwnSellBase, resolveHeldForSell, sellSkipLogLevel } from './sell-gate.js';
import { forceSellCooldownActive, forceSellCooldownBlock } from '../force-sell-cooldown.js';

/**
 * Stamp the override's id onto every order this branch emitted because of it.
 * The worker settles the override on what actually happened to those orders,
 * and it can only tie an order back to the override if the order carries the
 * id — a positional or side-based guess would settle the wrong row whenever a
 * tick emits an unrelated order alongside the override's.
 */
const attributeToOverride = (
  decisions: readonly Decision[],
  overrideActionId: string,
): Decision[] =>
  decisions.map((d) =>
    d.type === 'place-order' ? { ...d, intent: { ...d.intent, overrideActionId } } : d,
  );

/** The override the caller has already proven non-null. */
type Override = NonNullable<TTBundle['override']>;

/**
 * Branch on `override.kind` and return the corresponding tick output. Extracted
 * so {@link computeTick} stays readable. `now` is threaded in so the trigger-sell
 * path can arm the auto-trigger-buy timer.
 *
 * The override is taken as a parameter rather than re-read from the bundle: the
 * caller reaches here only inside an `override !== null` check, so passing the
 * narrowed value lets TS carry that proof in instead of forcing an unreachable
 * re-narrowing guard that no test could ever cover.
 */
export const handleOverride = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  nextState: TTState,
  now: number,
  override: Override,
): TickOutput<TTState> => {
  const out = overrideOutput(input, nextState, now, override);
  return { ...out, decisions: attributeToOverride(out.decisions, override.overrideActionId) };
};

const overrideOutput = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  nextState: TTState,
  now: number,
  override: Override,
): TickOutput<TTState> => {
  const { config, market } = input;
  switch (override.kind) {
    case 'manual-order': {
      // Manual order bypasses kill-switch / lbp / TV gate; the operator
      // typed an exact order and is asserting intent. Filter rejection
      // (min-qty, min-notional, etc.) still skips because Binance would
      // refuse the order anyway; the operator is told via log + metric.
      const result = computeManualOrderQuantity(
        override.payload,
        market.currentPrice,
        market.symbolInfo.filters,
      );
      if ('quantity' in result) {
        // A manual SELL may close the whole position; retract any resting
        // protective stop ahead of it so the exchange does not hold a stale
        // limit against an already-flat position (orphan ⇒ double-sell on a
        // later gap-down). A partial close re-arms next tick; a manual BUY adds
        // exposure and leaves the stop correctly in place, so cancel SELL-only.
        const cancels =
          override.payload.side === 'SELL' ? protectiveStopCancelDecisions(input) : [];
        return {
          // A manual order is not a buy-gate evaluation; clear any stale blocker
          // so the worker's prev/next diff and the symbol page do not show one.
          nextState: { ...nextState, entryBlocker: null },
          decisions: [
            ...cancels,
            buildManualOrderDecision(
              input,
              override.payload,
              result.quantity,
              override.overrideActionId,
            ),
          ],
          logs: [
            log('info', 'tt-manual-order', {
              symbol: market.symbol,
              overrideActionId: override.overrideActionId,
              side: override.payload.side,
              type: override.payload.type,
              quantity: result.quantity,
            }),
          ],
          metrics: [metric('tt_manual_order_emit', { symbol: market.symbol })],
        };
      }
      return {
        nextState: { ...nextState, entryBlocker: null },
        decisions: [{ type: 'noop' }],
        logs: [
          log('warn', 'tt-manual-order-skipped', {
            symbol: market.symbol,
            overrideActionId: override.overrideActionId,
            reason: result.skip,
          }),
        ],
        metrics: [
          metric('tt_manual_order_skipped', { symbol: market.symbol, reason: result.skip }),
        ],
        // Permanent for this order (a filter the typed quantity can never
        // satisfy), so not deferred — but the operator still needs to be told
        // WHY their order never went out, not just that it did not.
        overrideDeclineReason: result.skip,
      };
    }
    case 'trigger-buy': {
      // A prior force-sell's re-entry cooldown suppresses even an operator
      // trigger-buy: the operator wants to buy back into the same downturn the
      // strategy just sold out of, so refuse until the cooldown passes (the
      // override is one-shot and is consumed).
      if (forceSellCooldownActive(nextState, now)) {
        const blocked = forceSellCooldownBlock(market.symbol, nextState);
        return {
          nextState: { ...nextState, entryBlocker: null },
          decisions: [{ type: 'noop' }],
          logs: [blocked.log],
          metrics: [blocked.metric],
          overrideDeclineReason: 'force-sell-cooldown',
        };
      }
      // Trigger-buy reuses the strategy's first entry with the TV gate
      // forced open. Grid-aware via `emitForcedFirstEntry`: a grid profile
      // re-enters at level 0 (cancelling any stale lower-level open BUYs),
      // a non-grid profile uses the single buy. Honors disabledUntilMs so an
      // override during a stop-loss cooldown skips.
      const firstBuy = emitForcedFirstEntry(input, nextState, now);
      if (firstBuy.kind === 'emit') {
        return {
          // A buy just fired; clear any stale blocker so the worker's prev/next
          // diff fires the "no longer blocked" transition exactly once.
          nextState: { ...firstBuy.state, entryBlocker: null },
          decisions: firstBuy.decisions,
          logs: [
            log('info', 'tt-trigger-buy', {
              symbol: market.symbol,
              overrideActionId: override.overrideActionId,
              ...(firstBuy.level !== null
                ? { gridLevel: firstBuy.level, canceledStale: firstBuy.canceledStale }
                : { quantity: firstBuy.quantity }),
            }),
          ],
          metrics: [metric('tt_trigger_buy_emit', { symbol: market.symbol })],
        };
      }
      // A `wait` (lowest-price not reached / entry already resting) is not a
      // skip with structured context. The trigger-buy override is one-shot, so
      // unlike the auto-trigger-buy timer it has nothing to keep; report an
      // accurate reason rather than the old mislabelled `open-buy` (#369).
      const reason = firstBuy.kind === 'wait' ? 'awaiting-entry' : firstBuy.reason;
      const context = firstBuy.kind === 'wait' ? {} : (firstBuy.context ?? {});
      return {
        nextState: { ...nextState, entryBlocker: null },
        decisions: [{ type: 'noop' }],
        // Indicator-gate vetoes carry rsi/sma/ema readouts in `context` so
        // operators can see WHY a force-buy was blocked, not just THAT it was.
        // Spread first; fixed keys last so the stable log contract
        // (`symbol`/`overrideActionId`/`reason`) wins on collision.
        logs: [
          log('warn', 'tt-trigger-buy-skipped', {
            ...context,
            symbol: market.symbol,
            overrideActionId: override.overrideActionId,
            reason,
          }),
        ],
        metrics: [metric('tt_trigger_buy_skipped', { symbol: market.symbol, reason })],
        overrideDeclineReason: reason,
      };
    }
    case 'trigger-sell': {
      // Operator wants to bail on the current position. Emit MARKET SELL
      // of the full free balance regardless of price-level gates. Refuse
      // only when there's literally nothing to sell (no balance) or the
      // dust amount fails filters; in those cases the operator's
      // override is consumed but no order goes out, with a warn log.
      const baseAsset = market.symbolInfo.baseAsset;
      // The close batch below cancels our own resting protective stop before the
      // MARKET sell, so the base that stop locks is sellable here. Omitting it
      // read `free` as zero on any position its own stop defends — the operator's
      // manual close was refused on exactly the positions that needed it most.
      const free = resolveHeldForSell(
        nextState,
        baseAsset,
        input.account,
        reclaimableOwnSellBase(input),
      );
      const result = computeSellQuantity(free, market.currentPrice, market.symbolInfo.filters);
      if ('quantity' in result) {
        // Same state reset as the strategy-initiated SELL paths so the
        // next tick starts a fresh cycle. `currentGridTradeIndex` is
        // cleared in lockstep so grid-mode profiles do not fall into
        // the orphan-recovery path on the very next tick.
        // autoTriggerBuyAtMs arms the re-arm timer when the operator
        // opted into autoTriggerBuy; null (feature off) ends the cycle.
        const postSellState: TTState = {
          ...nextState,
          // The shared full-exit reset, not a hand-copied field list. This branch is terminal, so the flat-path clears further down the chain never run on the tick that closes the position: whatever this object omits ships committed. A private list here had already drifted from the canonical one, keeping both position-scoped blockers and the bull-pyramid counters alive past a manual close.
          //
          // `heldQuantity` is intentionally NOT cleared, and the helper leaves it alone for the same reason — the fill-adopter owns the authoritative transition on the executionReport (null on a position-emptying fill, the reduced remainder on a partial). An optimistic clear would make the next tick size against `wallet.free`, which excludes the qty Binance locks into this just-placed SELL, under-sizing any follow-up sell in the partial-fill window.
          ...clearedSellPosition(armAutoTriggerBuy(config, now)),
          // A closed position has no pending entry to block; drop any stale blocker. Not part of the sell-side reset because it is scoped to a FLAT profile, so the shared helper deliberately does not carry it.
          entryBlocker: null,
        };
        return {
          nextState: postSellState,
          decisions: [
            // Full-position MARKET close: retract any resting protective stop
            // first so it does not survive the flat position and double-sell on
            // a later gap-down.
            ...protectiveStopCancelDecisions(input),
            buildSellDecision(
              input,
              'manual',
              result.quantity,
              `trigger-sell-${override.overrideActionId}`,
            ),
          ],
          logs: [
            log('info', 'tt-trigger-sell', {
              symbol: market.symbol,
              overrideActionId: override.overrideActionId,
              quantity: result.quantity,
              freeBase: free,
            }),
          ],
          metrics: [metric('tt_trigger_sell_emit', { symbol: market.symbol })],
        };
      }
      const triggerSkipReason = (result as { skip: SellSkipReason }).skip;
      return {
        nextState: { ...nextState, entryBlocker: null },
        decisions: [{ type: 'noop' }],
        // Operator-actionable skips stay at WARN; idle / dust skips fall to
        // debug / info so the alert channel is not buried (#265). See
        // `sellSkipLogLevel` for the mapping.
        logs: [
          log(sellSkipLogLevel(triggerSkipReason), 'tt-trigger-sell-skipped', {
            symbol: market.symbol,
            overrideActionId: override.overrideActionId,
            reason: triggerSkipReason,
            freeBase: free,
          }),
        ],
        metrics: [
          metric('tt_trigger_sell_skipped', { symbol: market.symbol, reason: triggerSkipReason }),
        ],
        overrideDeclineReason: triggerSkipReason,
      };
    }
  }
};
