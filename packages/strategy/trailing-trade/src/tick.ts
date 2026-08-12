import { log, metric } from '@app/strategy-core';
import type {
  Decision,
  LogEntry,
  MarketSnapshot,
  MetricEntry,
  TickInput,
  TickOutput,
} from '@app/strategy-core';
import { Decimal } from '@app/money';
import { buildFirstBuyDecision, hasOpenBuyForSymbol } from './decisions.js';
import type { BranchHandler, BranchOutcome } from './branch.js';
import { buildScalars } from './scalars.js';
import { computeFirstBuyQuantity, type FirstBuySkipReason } from './quantity.js';
import { resolveEntryBudget, type EntrySizingSkip } from './sizing.js';
import { effectiveForceSellMinProfitPercent } from './fees.js';
import type { TTBundle, TTConfig, TTState } from './schema.js';
import {
  evaluateTechnicalsGate,
  type IntervalConsultation,
  type TVGateVeto,
} from './technicals-gate.js';
import { evaluateTechnicalsForceSell } from './technicals-force-sell.js';
import { forceSellCooldownActive, forceSellCooldownBlock } from './force-sell-cooldown.js';
import {
  lossExitCooldownActive,
  lossCooldownBlock,
  lossCooldownMinutesLeft,
} from './loss-cooldown.js';
import { resolveForceSellGuards } from './force-sell-guards.js';
import {
  evaluateIndicatorGate,
  type IndicatorGateContext,
  type IndicatorGateVeto,
} from './indicator-gate.js';
import { evaluateMeanReversionGate } from './mean-reversion-gate.js';
import { handleOverride } from './branches/override.js';
import { armAutoTriggerBuy, emitForcedFirstEntry } from './branches/first-entry.js';
import { clearedAddTracking, clearedSellPosition } from './position-lifecycle.js';
import { parseDecimal } from './branches/safe-decimal.js';
import {
  closedBarsSinceEntry,
  evaluateSellGate,
  sellEmissionOrSkip,
  technicalsForceSellTriggerPriceOf,
} from './branches/sell-gate.js';
import { evaluateGridBuy } from './branches/grid-buy.js';
import type { ChaseGuardVeto, KnifeGuardVeto } from './branches/entry-guards.js';
import {
  evaluateProtectiveStop,
  protectiveStopCancelDecisions,
} from './branches/protective-stop.js';
import { evaluateBullPyramid } from './branches/bull-pyramid.js';
import type { RiskCap, RiskCapVeto } from './branches/risk-caps.js';
import type { RegimeVeto } from './branches/regime-filter.js';
import { regimeExposure } from './branches/regime-exposure.js';
import {
  evaluateRegimeExit,
  evaluateRegimeEntryBlock,
  evaluateRegimeEntryRequirement,
  evaluateRegimeRearm,
} from './branches/regime-exit.js';
import { resolveEntryBlocker, type AwaitingTriggerDetail } from './entry-blocker.js';

// Loss-exit stamp for the re-entry cooldown. Returns the two state fields to
// merge when a sell-side exit realised a loss (currentPrice strictly below the
// average cost), else an empty object (no stamp). grid-stop-loss is always a
// loss, so its caller stamps unconditionally; the regime exit may sell at a loss
// or not, so it gates on the price comparison here; technicals-force-sell can
// only fire in profit (its evaluator's profit guard), so this returns empty
// there. A parse failure leaves no stamp rather than mis-flagging a loss.
const lossExitStamp = (
  reason: TTState['lastLossExitReason'],
  currentPrice: string,
  avgEntryPrice: string | null,
  now: number,
): Partial<Pick<TTState, 'lastLossExitAt' | 'lastLossExitReason'>> => {
  /* v8 ignore start -- reason: every caller is a sell-emit site that already holds a position (avgEntryPrice non-null) and re-uses prices the sell gate parsed successfully, so the null and parse-fail guards are unreachable by construction; they are belt-and-braces against a future caller */
  if (avgEntryPrice === null) return {};
  const priceParse = parseDecimal(currentPrice);
  const avgParse = parseDecimal(avgEntryPrice);
  if (!priceParse.ok || !avgParse.ok) return {};
  /* v8 ignore stop -- reason: end of the unreachable defensive guards above */
  if (!priceParse.value.lt(avgParse.value)) return {};
  return { lastLossExitAt: now, lastLossExitReason: reason };
};

// Branch precedence chain. The tuple order below IS the strategy's tacit
// priority: auto-trigger-buy fires before the disabled noop guard;
// lbp-clear runs before the sell gate; technicals-force-sell runs inside
// the sell gate before the regular ladder. Reordering changes behaviour.
// Each branch is an inline closure over the helpers defined below; the
// dispatcher threads `state` + `preambleLogs` between them.

// Clears an expired disable window so downstream branches see a live
// profile. Pure normalisation; never terminal.
const applyDisabledClearBranch: BranchHandler = (ctx) => {
  const { state, scalars } = ctx;
  if (state.disabledUntilMs !== null && state.disabledUntilMs <= scalars.now) {
    return {
      kind: 'mutate',
      state: { ...state, disabledUntilMs: null },
      preambleLogs: ctx.preambleLogs,
    };
  }
  return { kind: 'pass' };
};

const overrideBranch: BranchHandler = (ctx) => {
  const override = ctx.input.bundle.override;
  if (override !== null) {
    return {
      kind: 'terminal',
      output: handleOverride(ctx.input, ctx.state, ctx.scalars.now, override),
    };
  }
  return { kind: 'pass' };
};

// Builds the repeated auto-trigger-buy skip terminal: consume the timer
// (autoTriggerBuyAtMs is cleared identically across every skip reason),
// noop, and emit the paired skip log + metric. `reason` is the only
// difference between the three guard blocks; `level: 'warn'` + `context`
// carry the forced-entry rejection readout for the fall-through skip.
const autoTriggerSkipTerminal = (
  state: TTState,
  symbol: string,
  reason: string,
  opts?: {
    readonly level?: 'warn';
    readonly context?: Readonly<Record<string, unknown>> | undefined;
  },
): BranchOutcome => ({
  kind: 'terminal',
  output: {
    // An auto-trigger skip is not a live buy-gate block; clear any stale
    // persisted blocker so the worker's prev/next diff stays clean.
    nextState: { ...state, autoTriggerBuyAtMs: null, entryBlocker: null },
    decisions: [{ type: 'noop' }],
    // Spread context first; fixed keys last so the stable log contract wins
    // on collision (matches the pre-extraction fall-through ordering).
    logs: [
      log(opts?.level ?? 'info', 'tt-auto-trigger-buy-skipped', {
        ...(opts?.context ?? {}),
        symbol,
        reason,
      }),
    ],
    metrics: [metric('tt_auto_trigger_buy_skipped', { symbol, reason })],
  },
});

// Auto-trigger-buy: a prior sell that cleared the position armed a re-arm
// timer. When due, fire a fresh first entry with the TV gate forced open.
// Evaluated before the disabledUntilMs noop guard so the reschedule-while-
// disabled path can observe an unexpired disable. The no-reschedule
// disabled case passes through to the disabled gate with the timer armed.
const autoTriggerBuyBranch: BranchHandler = (ctx) => {
  const { state, scalars } = ctx;
  const { config, market } = ctx.input;
  const now = scalars.now;
  if (!(state.autoTriggerBuyAtMs !== null && state.autoTriggerBuyAtMs <= now)) {
    return { kind: 'pass' };
  }
  if (forceSellCooldownActive(state, now)) {
    // The re-arm timer is due but a prior force-sell's re-entry cooldown is
    // still active: keep the timer armed (it re-checks next tick) and noop, so
    // the re-entry the operator armed does not fire dead into the downturn.
    const blocked = forceSellCooldownBlock(market.symbol, state);
    return {
      kind: 'terminal',
      output: {
        // Timer is held, not a buy-gate block; clear any stale persisted blocker.
        nextState: { ...state, entryBlocker: null },
        decisions: [{ type: 'noop' }],
        logs: [blocked.log],
        metrics: [blocked.metric],
      },
    };
  }
  if (lossExitCooldownActive(state, config, now)) {
    // Same as the force-sell cooldown above, for a prior LOSS exit: hold the
    // re-arm timer rather than buying back into the drop it just sold into.
    const blocked = lossCooldownBlock(market.symbol, state);
    return {
      kind: 'terminal',
      output: {
        nextState: { ...state, entryBlocker: null },
        decisions: [{ type: 'noop' }],
        logs: [blocked.log],
        metrics: [blocked.metric],
      },
    };
  }
  if (!config.buy.autoTriggerBuy.enabled) {
    return autoTriggerSkipTerminal(state, market.symbol, 'feature-disabled');
  }
  if (state.disabledUntilMs !== null) {
    if (config.buy.autoTriggerBuy.rescheduleWhileDisabled) {
      return {
        kind: 'terminal',
        output: {
          nextState: {
            ...state,
            autoTriggerBuyAtMs: armAutoTriggerBuy(config, now),
            entryBlocker: null,
          },
          decisions: [{ type: 'noop' }],
          logs: [log('info', 'tt-auto-trigger-buy-rescheduled', { symbol: market.symbol })],
          metrics: [metric('tt_auto_trigger_buy_rescheduled', { symbol: market.symbol })],
        },
      };
    }
    // No reschedule: leave the timer armed (now in the past) and fall
    // through to the disabled gate. It fires unchanged on the first tick
    // after the profile is re-enabled.
    return { kind: 'pass' };
  }
  if (!config.buy.enabled) {
    return autoTriggerSkipTerminal(state, market.symbol, 'buy-disabled');
  }
  if (state.avgEntryPrice !== null) {
    return autoTriggerSkipTerminal(state, market.symbol, 'holding');
  }
  // Timer due, profile live, flat: consume the timer and emit the first
  // entry with the TV gate forced open (grid-aware via emitForcedFirstEntry).
  const consumed: TTState = { ...state, autoTriggerBuyAtMs: null };
  const firstBuy = emitForcedFirstEntry(ctx.input, consumed, now);
  if (firstBuy.kind === 'wait') {
    // A `lowest-price` basis has not reached the window low yet: keep the timer
    // armed (return the original `state`, not `consumed`) so the forced
    // re-entry re-checks next tick instead of being discarded and falling back
    // to the normal TV-gated entry the operator opted to bypass (#369).
    return {
      kind: 'terminal',
      output: {
        // Timer re-checks next tick; not a buy-gate block, so clear any stale blocker.
        nextState: { ...state, entryBlocker: null },
        decisions: [{ type: 'noop' }],
        logs: [
          log('info', 'tt-auto-trigger-buy-waiting', {
            symbol: market.symbol,
            reason: 'awaiting-entry',
          }),
        ],
        metrics: [metric('tt_auto_trigger_buy_waiting', { symbol: market.symbol })],
      },
    };
  }
  if (firstBuy.kind === 'emit') {
    return {
      kind: 'terminal',
      output: {
        // A buy just fired; drop any stale blocker so the worker's prev/next
        // diff fires the one-shot "no longer blocked" transition exactly once.
        // Also clear the loss-exit cooldown stamp + confirm streak: the position
        // is open again. (The force-sell cooldown was already checked above; this
        // path is only reached when no cooldown was active.)
        nextState: {
          ...firstBuy.state,
          lastLossExitAt: null,
          lastLossExitReason: null,
          entryConfirmCount: 0,
          entryBlocker: null,
        },
        decisions: firstBuy.decisions,
        logs: [
          log('info', 'tt-auto-trigger-buy', {
            symbol: market.symbol,
            ...(firstBuy.level !== null
              ? { gridLevel: firstBuy.level, canceledStale: firstBuy.canceledStale }
              : { quantity: firstBuy.quantity }),
          }),
        ],
        metrics: [metric('tt_auto_trigger_buy_emit', { symbol: market.symbol })],
      },
    };
  }
  return autoTriggerSkipTerminal(consumed, market.symbol, firstBuy.reason, {
    level: 'warn',
    context: firstBuy.context,
  });
};

const disabledGateBranch: BranchHandler = (ctx) => {
  if (ctx.state.disabledUntilMs !== null) {
    return {
      kind: 'terminal',
      // A disabled profile is not evaluating a buy gate; clear any stale blocker
      // so the symbol page does not show a frozen "waiting for ..." line.
      output: {
        nextState: { ...ctx.state, entryBlocker: null },
        decisions: [{ type: 'noop' }],
        logs: [],
        metrics: [],
      },
    };
  }
  return { kind: 'pass' };
};

// avg-entry-price remove threshold: when the operator's configured threshold
// has tripped AND there is no open BUY AND we hold no position, clear
// `avgEntryPrice` so the first-buy gate re-fires this same tick at the now-
// low price. Escape hatch; the immediate re-entry is intentional.
const lbpClearBranch: BranchHandler = (ctx) => {
  const lbpClear = maybeClearAvgEntryPrice(ctx.input, ctx.state);
  if (lbpClear !== null) {
    return {
      kind: 'mutate',
      state: lbpClear.state,
      preambleLogs: [...ctx.preambleLogs, lbpClear.log],
    };
  }
  return { kind: 'pass' };
};

// Sell-side checks: technicals-force-sell, then stop-loss / trigger-arm /
// trailing-stop. Mutually exclusive with the first-buy path (sell requires
// lbp set; first-buy requires lbp null). Open-SELL de-dup prevents racing a
// strategy SELL against an operator manual SELL already in flight.
const sellGateBranch: BranchHandler = (ctx) => {
  const { scalars } = ctx;
  const { config, market, bundle } = ctx.input;
  const now = scalars.now;
  let state = ctx.state;
  const preambleLogs: LogEntry[] = [...ctx.preambleLogs];
  if (config.sell.enabled && state.avgEntryPrice !== null && !scalars.hasOpenSell) {
    // Force-sell-on-Technicals runs before the standard sell gate so a
    // stop-loss still wins when both fire (stop-loss is the safety net; TV
    // pressure is opportunistic).
    const triggerPx = technicalsForceSellTriggerPriceOf(config, state);
    if (triggerPx.parseFail) {
      // Same shape evaluateSellGate's parse-fail branch uses so a corrupted
      // sell.triggerPercentage surfaces from both code paths.
      preambleLogs.push(
        log('warn', 'tt-sell-gate-parse-failed', {
          field: 'triggerPercentage',
          source: 'technicals-force-sell',
          value: config.sell.triggerPercentage,
        }),
      );
    }
    // Discovery single-entries do not force-sell. A momentum/breakout pick
    // exits via the ATR trailing stop (let a winner run) or the hard stop /
    // time-stop (cap a loss). The technicals force-sell otherwise clips these
    // winners at a tiny profit the moment a short interval flips bearish, which
    // on a fresh breakout is noise. A plain (non-discovery) position keeps the
    // force-sell, gated by the opt-in min-profit floor below.
    const technicalsForceSell =
      state.discoveryEntry === true
        ? ({ ok: false } as const)
        : evaluateTechnicalsForceSell({
            tv: bundle.technicals,
            currentPrice: market.currentPrice,
            avgEntryPrice: state.avgEntryPrice,
            triggerPrice: triggerPx.price,
            nowMs: now,
            // Floor the discretionary exit at break-even-after-fees: the larger
            // of the operator's forceSellMinProfitPercent and the round-trip fee.
            // With fees unset this is the configured value verbatim.
            minProfitPercent: effectiveForceSellMinProfitPercent(config),
          });
    // Confirm window: the trigger must stay present for confirmMinutes before
    // the force-sell emits. forceSellFirstSeenAtMs stamps the first present tick
    // and clears the moment the trigger is absent, so a flickering signal never
    // bails out of a position. Resolved (not read raw) so a stored config that
    // omits the field gets the safe non-zero default at tick time when a sub-1h
    // trigger is armed; an explicit 0 still emits on the first matching tick.
    const guards = resolveForceSellGuards(config.technicals);
    const confirmMs = guards.confirmMinutes * 60_000;
    if (technicalsForceSell.ok) {
      // Stamp the first present tick, then read the (now non-null) first-seen via
      // a local so TS keeps the narrowing after the `state` reassignment.
      const firstSeenAtMs = state.forceSellFirstSeenAtMs ?? now;
      // Only stamp when the confirm window is actually in use. At confirmMs=0
      // (default) the window check below is `0 < 0` (false) and we fall through
      // to emit, so stamping here would leak a non-null firstSeen on a skip tick
      // and diverge from the pre-change default path.
      if (confirmMs > 0 && state.forceSellFirstSeenAtMs === null) {
        state = { ...state, forceSellFirstSeenAtMs: firstSeenAtMs };
      }
      if (now - firstSeenAtMs < confirmMs) {
        // Still inside the confirm window: keep the position and let the standard
        // sell gate run this tick. The first-seen stamp persists on `state`.
        preambleLogs.push(
          log('info', 'tt-force-sell-confirm-pending', {
            symbol: market.symbol,
            interval: technicalsForceSell.interval,
            recommendation: technicalsForceSell.recommendation,
            firstSeenAtMs,
            confirmMinutes: guards.confirmMinutes,
          }),
        );
      } else {
        const emission = sellEmissionOrSkip(
          ctx.input,
          state,
          'technicals-force-sell',
          'tt-technicals-force-sell',
          `technicals-${technicalsForceSell.interval}-${technicalsForceSell.recommendation}-${state.avgEntryPrice}`,
        );
        if (emission.kind === 'emit') {
          // `heldQuantity` is intentionally NOT cleared here — the fill-adopter
          // owns the authoritative transition on the executionReport. An
          // optimistic clear would under-size a follow-up sell in the
          // partial-fill window (wallet.free excludes the locked qty).
          // The re-entry cooldown stamps here and deliberately survives the
          // position close (clearedSellPosition does not reset it) so every
          // first-entry path can suppress a buy-back into the same downturn. A 0
          // cooldown leaves the field null (no stamp) so existing configs and
          // the golden replay are byte-for-byte unchanged.
          const cooldownMs = guards.cooldownMinutes * 60_000;
          const postSellState: TTState = {
            ...state,
            ...clearedSellPosition(armAutoTriggerBuy(config, now)),
            forceSellCooldownUntilMs: cooldownMs > 0 ? now + cooldownMs : null,
            // Stamp the loss-exit cooldown only if this exit realised a loss. A
            // technicals force-sell carries a profit guard, so this is empty in
            // practice; the uniform helper keeps the rule correct if that guard
            // ever changes.
            ...lossExitStamp(
              'technicals-force-sell',
              market.currentPrice,
              state.avgEntryPrice,
              now,
            ),
            // A closed position has no pending entry to block; drop any stale
            // promotion-veto blocker so the worker's prev/next diff is clean.
            entryBlocker: null,
          };
          return {
            kind: 'terminal',
            output: {
              nextState: postSellState,
              // Retract any resting protective stop before the market sell so a
              // gap-through that armed it does not leave a stale limit order.
              decisions: [...protectiveStopCancelDecisions(ctx.input), emission.decision],
              logs: [
                ...preambleLogs,
                {
                  ...emission.log,
                  context: {
                    ...(emission.log.context as Record<string, unknown>),
                    interval: technicalsForceSell.interval,
                    recommendation: technicalsForceSell.recommendation,
                    ageMs: technicalsForceSell.ageMs,
                    useOnlyWithinMin: bundle.technicals.config.useOnlyWithinMin,
                  },
                },
              ],
              metrics: [metric('tt_tv_force_sell_emit', { symbol: market.symbol })],
            },
          };
        }
        // emission is emit|skip here (sellEmissionOrSkip never returns noop), so
        // the else arm of this skip check is unreachable by construction. The
        // body is behaviour-tested (tt-technicals-force-sell-skipped); the ignore
        // drops only the dead else branch.
        /* v8 ignore start -- reason: sellEmissionOrSkip returns only emit|skip and the emit case returned above, so emission is always skip here; the implicit else is unreachable */
        if (emission.kind === 'skip') {
          preambleLogs.push(emission.log);
          return {
            kind: 'terminal',
            output: {
              nextState: state,
              decisions: [
                {
                  type: 'emit-event',
                  eventType: 'tick-snapshot',
                  payload: { symbol: market.symbol, currentPrice: market.currentPrice, tsMs: now },
                },
              ],
              logs: preambleLogs,
              metrics: [metric('tt_tv_force_sell_skipped', { symbol: market.symbol })],
            },
          };
        }
        /* v8 ignore stop -- reason: end of the unreachable emit|skip else arm above */
      }
    } else if (state.forceSellFirstSeenAtMs !== null) {
      // Trigger absent this tick: reset the pending confirm window so a future
      // re-appearance must satisfy the full window again.
      state = { ...state, forceSellFirstSeenAtMs: null };
    }
    const sellResult = evaluateSellGate(ctx.input, state);
    if (sellResult.kind === 'emit') {
      // Optimistic state reset on emit. currentGridTradeIndex
      // resets in lockstep with avgEntryPrice so the next entry re-fires
      // level 0; heldQuantity is left to the fill-adopter (see above).
      // The grid sell gate emits a stop-loss (always a loss), a trailing /
      // ATR profit-take (grid-sell), or a discovery time-stop. Only the
      // stop-loss arms the loss-exit cooldown — a profit-take must not, or it
      // would block a fresh entry after a winning trade. The metric name is the
      // sole carrier of the exit reason out of evaluateSellGate.
      const lossStamp =
        sellResult.metricName === 'tt_grid_stop_loss_emit'
          ? lossExitStamp('grid-stop-loss', market.currentPrice, state.avgEntryPrice, now)
          : {};
      const postSellState: TTState = {
        ...state,
        ...clearedSellPosition(armAutoTriggerBuy(config, now)),
        ...lossStamp,
        entryBlocker: null,
      };
      return {
        kind: 'terminal',
        output: {
          nextState: postSellState,
          // Cancel any resting protective stop ahead of the close. This is the
          // backstop's primary path: a gap-through fires the in-process MARKET
          // stop-loss here, and the resting exchange stop is retracted in the
          // same ordered batch so it cannot also fire against a flat position.
          decisions: [...protectiveStopCancelDecisions(ctx.input), sellResult.decision],
          logs: [...preambleLogs, sellResult.log],
          metrics: [metric(sellResult.metricName, { symbol: market.symbol })],
        },
      };
    }
    if (sellResult.kind === 'bump-high') {
      state = sellResult.state;
    }
    if (sellResult.kind === 'skip') {
      preambleLogs.push(sellResult.log);
    }
    // Regime exit (opt-in cash rotation): the per-symbol gates above declined to
    // sell — exit to cash now if the DAILY regime is CONFIRMED bearish (the last
    // N closed daily candles all below the regime MA). Placed last so stop-loss
    // and the trailing stop keep their exact precedence (and golden fixtures):
    // by the time a daily downtrend is confirmed the trailing stop has usually
    // already fired, so this catches the position that went underwater and never
    // bounced — exiting at a loss by design. Fail-safe lives in
    // evaluateRegimeExit (a short window yields `unavailable`, never `bear`).
    const regimeExit = evaluateRegimeExit(market, config);
    if (regimeExit.kind === 'bear') {
      const emission = sellEmissionOrSkip(
        ctx.input,
        state,
        'regime-exit',
        'tt-regime-exit',
        `regime-exit-${state.avgEntryPrice}`,
      );
      if (emission.kind === 'emit') {
        // Do NOT arm auto-trigger-buy: re-entry must wait for the regime to
        // recover (the entry guard blocks buys while bear), not a fixed timer.
        const postSellState: TTState = {
          ...state,
          ...clearedSellPosition(null),
          // A regime exit sells at a loss by design when underwater; stamp the
          // loss-exit cooldown in that case so a recovery does not immediately
          // re-buy into the same drop.
          ...lossExitStamp('regime-exit', market.currentPrice, state.avgEntryPrice, now),
          entryBlocker: null,
        };
        return {
          kind: 'terminal',
          output: {
            nextState: postSellState,
            // Retract any resting protective stop before the cash-rotation exit.
            decisions: [...protectiveStopCancelDecisions(ctx.input), emission.decision],
            logs: [
              ...preambleLogs,
              {
                ...emission.log,
                context: {
                  ...(emission.log.context as Record<string, unknown>),
                  ...regimeExit.context,
                },
              },
            ],
            metrics: [metric(emission.metricName, { symbol: market.symbol })],
          },
        };
      }
      // Position unsellable (dust / filters): record the skip and fall
      // through; the entry guard still keeps us from re-buying. emission is
      // emit|skip here (sellEmissionOrSkip never returns noop), so the skip
      // check's else arm is unreachable.
      /* v8 ignore start -- reason: sellEmissionOrSkip returns only emit|skip and emit returned above, so emission is always skip here; the else arm is unreachable by construction */
      if (emission.kind === 'skip') preambleLogs.push(emission.log);
      /* v8 ignore stop -- reason: end of the unreachable emit|skip else arm above */
    }
  }

  // Protective-stop arm. Deliberately OUTSIDE the `!hasOpenSell` guard above: a
  // foreign resting SELL is exactly the state that starves the stop of base, so
  // gating the arm on it would hide the one case the operator most needs to see.
  // The guard only exists to stop a strategy MARKET sell racing an in-flight
  // manual SELL; a resting STOP_LOSS_LIMIT does not race anything.
  // Position-preserving — this places / re-prices a resting order, it does not
  // close the position.
  if (config.sell.enabled && state.avgEntryPrice !== null) {
    const arm = evaluateProtectiveStop(ctx.input, state);
    // Persist the blocker (or its absence) on every held tick so the dashboard
    // reflects the CURRENT protection state, not the last one that changed.
    state = { ...state, protectiveStopBlocker: arm.blocker };
    if (arm.decisions.length > 0) {
      return {
        kind: 'terminal',
        output: {
          // The position is unchanged; only carry the bumped high (if the
          // trigger-arm ran) and drop any stale blocker like sibling branches.
          nextState: { ...state, entryBlocker: null },
          decisions: arm.decisions,
          logs: [
            ...preambleLogs,
            log('info', 'tt-protective-stop-arm', {
              symbol: market.symbol,
              rearm: arm.decisions.length > 1,
            }),
          ],
          metrics: [metric('tt_protective_stop_arm', { symbol: market.symbol })],
        },
      };
    }
    if (arm.blocker !== null) {
      preambleLogs.push(
        log('warn', 'tt-protective-stop-blocked', {
          symbol: market.symbol,
          reason: arm.blocker.reason,
          ...arm.blocker.detail,
        }),
      );
    }
  } else if (state.protectiveStopBlocker !== null) {
    // Flat (or the sell side is off): there is nothing left to protect, so a
    // stale "unprotected" warning must not outlive the position.
    state = { ...state, protectiveStopBlocker: null };
  }
  return { kind: 'mutate', state, preambleLogs };
};

// Grid / non-grid first-buy evaluation followed by the guaranteed tick-
// snapshot terminal. The veto locals are shared between the buy evaluation
// and the snapshot's log assembly, so the two stay in one branch.
const buyAndSnapshotBranch: BranchHandler = (ctx) => {
  const { scalars } = ctx;
  const { config, market, bundle } = ctx.input;
  const now = scalars.now;
  let state = ctx.state;
  const preambleLogs: LogEntry[] = [...ctx.preambleLogs];

  // Entry suppression — refuse to open a fresh position while the daily regime
  // is CONFIRMED bear, so the profile sits out the downtrend. Fires on EITHER
  // bear-side entry toggle: `onBear.exitToCash` (the entry half of cash rotation,
  // unchanged) OR `onBear.blockEntry` (sit out WITHOUT force-selling holdings).
  // Only consulted when flat, so it never blocks a promotion. Fail-safe / inert
  // until the daily window is long enough (returns `unavailable`).
  let regimeEntryBlock: Readonly<Record<string, unknown>> | null = null;
  // Cancels for any resting entry BUY left over when the regime turned bear.
  // Populated only when the block fires; prepended to the snapshot terminal's
  // decisions below. Empty on every other path.
  let regimeEntryBlockCancels: readonly Decision[] = [];
  // True when the block is the require-uptrend gate (neutral/bear/unavailable)
  // rather than the bear block, so the entry-blocker reason is labelled apart.
  let regimeRequireUptrend = false;
  if (state.avgEntryPrice === null) {
    // Free a resting entry BUY placed before a regime gate fired: suppressing
    // NEW buys is not enough, a resting limit would still fill the entry the
    // block exists to prevent and ties up quote until it does. Same
    // retract-resting-order-before-acting shape the sell gate uses for the
    // protective stop, opposite side. Only flat here, so these are first-entry
    // orders. Idempotent like grid-buy's staleCancels: the executor DELs the
    // open-orders cache on cancel and -2011 (already gone) counts as success.
    const cancelRestingEntryBuys = (): readonly Decision[] =>
      ctx.input.openOrders
        .filter((o) => o.symbol === market.symbol && o.side === 'BUY')
        .map((o): Decision => ({
          type: 'cancel-order',
          orderId: o.orderId,
          symbol: market.symbol,
          reason: 'tt-regime-entry-block',
        }));

    // Require-uptrend gate (opt-in via onBull.requireEntry): open a fresh
    // position only on a confirmed daily bull. Independent of the bear block and
    // its re-arm — neutral, bear, AND unavailable all block, so a faster
    // Technical Rating cannot lift it. Checked first; a block here subsumes the
    // bear path (a confirmed bull is never a confirmed bear). Inert by default.
    const requireUptrend = evaluateRegimeEntryRequirement(market, config);
    if (requireUptrend.kind === 'block') {
      regimeEntryBlock = requireUptrend.context;
      regimeRequireUptrend = true;
      regimeEntryBlockCancels = cancelRestingEntryBuys();
    } else if (requireUptrend.kind === 'disabled') {
      // evaluateRegimeEntryBlock tolerates a missing regime block (returns
      // 'disabled'), so this is safe on raw stored configs that predate the field.
      const verdict = evaluateRegimeEntryBlock(market, config);
      if (verdict.kind === 'bear') {
        // Re-arm override (opt-in, blockEntry-only): a faster Technical Rating can
        // lift the bear entry block before price reclaims the slow daily MA, so a
        // recovery is tradeable without dropping the downtrend protection.
        const rearm = evaluateRegimeRearm(bundle.technicals, config, now);
        if (rearm.kind === 'rearmed') {
          preambleLogs.push(
            log('info', 'tt-regime-rearm', { symbol: market.symbol, ...rearm.context }),
          );
        } else {
          regimeEntryBlock = verdict.context;
          regimeEntryBlockCancels = cancelRestingEntryBuys();
        }
      }
    }
  }

  // Maker entry timeout (opt-in). Cancel a passive entry buy that has rested
  // unfilled for entryTimeoutBars closed candles so the next tick re-prices it
  // to the current market instead of dead-resting at a stale level. A maker entry
  // is a GTC LIMIT (Binance has no per-order expiry), so without this the only
  // ways off the book are a fill or a cancel. Maker mode only, and flat only: a
  // promotion's resting buy is re-priced by the grid path, and the regime block
  // already retracts resting entry buys, so skip when either holds. STOP_LOSS_LIMIT
  // breakout buys are left alone (they are meant to wait for the stop trigger, not
  // a timer). Age is read off the order's placement time, so no state field is
  // needed and the same cancel decision flows through backtest and live
  // identically. A manual resting LIMIT buy is also caught, matching the regime
  // block's broad flat retract.
  let entryTimeoutCancels: readonly Decision[] = [];
  const entryTimeoutBars = config.execution?.entryTimeoutBars ?? 0;
  if (
    state.avgEntryPrice === null &&
    regimeEntryBlock === null &&
    entryTimeoutBars > 0 &&
    config.execution?.entryMode === 'maker'
  ) {
    entryTimeoutCancels = ctx.input.openOrders
      .filter(
        (o) =>
          o.symbol === market.symbol &&
          o.side === 'BUY' &&
          o.type === 'LIMIT' &&
          closedBarsSinceEntry(market, config.candleInterval, o.transactTimeMs) >= entryTimeoutBars,
      )
      .map((o): Decision => ({
        type: 'cancel-order',
        orderId: o.orderId,
        symbol: market.symbol,
        reason: 'tt-entry-timeout',
      }));
  }

  // Re-entry cooldown — suppress a fresh first entry while a prior force-sell's
  // cooldown is still active. Only consulted when flat (a promotion keeps an
  // existing position; the cooldown gates buying BACK into a closed one).
  const forceSellCooled = state.avgEntryPrice === null && forceSellCooldownActive(state, now);

  // Loss-exit re-entry cooldown — the same idea for a prior LOSS exit (stop-loss
  // or an underwater force-sell / regime exit). Independent of the force-sell
  // cooldown above: a stop-loss arms only this one. Only consulted when flat.
  const lossExitCooled = state.avgEntryPrice === null && lossExitCooldownActive(state, config, now);

  let skipReason: FirstBuySkipReason | EntrySizingSkip | null = null;
  let tvVeto: {
    readonly reason: TVGateVeto;
    readonly interval: string;
    readonly intervalsConsulted: readonly IntervalConsultation[];
  } | null = null;
  // The TV gate runs before the indicator gate on every buy path, so at
  // most one of these is set per tick.
  let indicatorVeto: {
    readonly reason: IndicatorGateVeto;
    readonly context: IndicatorGateContext;
  } | null = null;
  // An opt-in risk cap (exposure / loss budget) refused a grid level. Mutually
  // exclusive with the gates above: the caps run only after they pass.
  let riskCapVeto: {
    readonly cap: RiskCap;
    readonly context: RiskCapVeto['context'];
  } | null = null;
  // A regime filter halted a promotion (daily downtrend). Promotion-only, so
  // mutually exclusive with the entry-only TV gate.
  let regimeVeto: {
    readonly reason: RegimeVeto;
    readonly context: Readonly<Record<string, unknown>>;
  } | null = null;
  // A discovery entry was refused for lacking a hard stop (fail-closed). Entry-
  // only, so mutually exclusive with the promotion-only regime veto.
  let guardrailVeto: {
    readonly reason: 'discovery-no-stop';
    readonly context: Readonly<Record<string, unknown>>;
  } | null = null;
  // Discovery anti-chase vetoes (#473). Entry-only and default-off; carried out
  // of evaluateGridBuy so the snapshot terminal surfaces chase-guard / knife-guard.
  let chaseGuardVeto: ChaseGuardVeto | null = null;
  let knifeGuardVeto: KnifeGuardVeto | null = null;
  // The lowest-price first-buy deferral context, carried out of evaluateGridBuy's
  // `wait` so the snapshot terminal can explain the silent wait as
  // `awaiting-trigger-price`. Null on every other path.
  let awaitingTrigger: AwaitingTriggerDetail | null = null;
  // Technicals entry-confirm hysteresis state. Carries the consecutive-allow
  // streak that the non-grid first-entry gate updates this tick; persisted to
  // nextState on EVERY terminal below so it never goes stale. `confirming` is set
  // when the gate ALLOWED but the streak has not yet reached the configured
  // threshold, so the first buy waits one more qualifying tick.
  let entryConfirmCount = state.entryConfirmCount;
  let technicalsConfirming: { readonly detail: Readonly<Record<string, unknown>> } | null = null;

  // Bull pyramid (opt-in): on a confirmed daily bull, add to a held position on
  // strength above cost. Runs BEFORE the grid promotion so an up-add beats a
  // down-add (in a bull a promotion cannot fire anyway, but precedence is
  // deterministic); the sell gate already ran above, so an exit always beats an
  // add. Independent of grid config — it has its own state and clientOrderId.
  if (config.buy.enabled && state.avgEntryPrice !== null) {
    const pyramid = evaluateBullPyramid(ctx.input, state);
    if (pyramid.kind === 'add') {
      return {
        kind: 'terminal',
        output: {
          nextState: { ...pyramid.nextState, entryBlocker: null },
          decisions: pyramid.decisions,
          logs: [...preambleLogs, pyramid.log],
          metrics: [
            metric('tt_bull_pyramid_add', {
              symbol: market.symbol,
              addIndex: String(pyramid.addIndex),
            }),
          ],
        },
      };
    }
    if (pyramid.kind === 'skip-cap') {
      // Surface the same risk-cap veto the grid uses; falls through to the grid
      // path (which noops in a bull) so the snapshot terminal logs the cap.
      riskCapVeto = { cap: pyramid.cap, context: pyramid.context };
    }
  }

  // Grid mode: empty `gridLevels` falls through to the single-buy
  // branch (no behaviour change for pre-grid configs). `regimeEntryBlock` is
  // only ever set when flat, so this still runs for promotions while holding.
  if (
    regimeEntryBlock === null &&
    !forceSellCooled &&
    !lossExitCooled &&
    config.buy.enabled &&
    config.buy.gridLevels.length > 0
  ) {
    // Legacy state normalisation: a pre-grid profile has avgEntryPrice set
    // but currentGridTradeIndex null — treat the held position as a level-0
    // fill so the next tick can promote off it.
    if (state.avgEntryPrice !== null && state.currentGridTradeIndex === null) {
      state = { ...state, currentGridTradeIndex: 0 };
    }
    // Defensive recovery for orphaned states (idx >= 1 without an lbp
    // anchor). idx=0 is excluded: that is the transient post-L0-emit shape
    // and must not be reset, or L0 re-fires every tick before adoption.
    if (
      state.avgEntryPrice === null &&
      state.currentGridTradeIndex !== null &&
      state.currentGridTradeIndex > 0
    ) {
      const orphanedIndex = state.currentGridTradeIndex;
      state = { ...state, currentGridTradeIndex: null };
      preambleLogs.push(
        log('warn', 'tt-grid-state-orphan-reset', { symbol: market.symbol, orphanedIndex }),
      );
    }

    const gridResult = evaluateGridBuy(ctx.input, state, now);
    if (gridResult.kind === 'emit') {
      // A buy fired this tick (level-0 entry or a promotion). Clear the loss-exit
      // cooldown stamp and the confirm streak: the position is open, so the
      // re-entry guard has nothing left to gate. Harmless on a promotion, where
      // both were already inert (only set while flat).
      return {
        kind: 'terminal',
        output: {
          nextState: {
            ...gridResult.state,
            lastLossExitAt: null,
            lastLossExitReason: null,
            entryConfirmCount: 0,
            entryBlocker: null,
          },
          decisions: gridResult.decisions,
          logs: [...preambleLogs, gridResult.log],
          metrics: [
            metric('tt_grid_buy_emit', { symbol: market.symbol, level: String(gridResult.level) }),
          ],
        },
      };
    }
    if (gridResult.kind === 'skip-filter') {
      skipReason = gridResult.skip;
    } else if (gridResult.kind === 'skip-tv') {
      tvVeto = {
        reason: gridResult.veto,
        interval: gridResult.interval,
        intervalsConsulted: gridResult.intervalsConsulted,
      };
    } else if (gridResult.kind === 'skip-indicator') {
      indicatorVeto = { reason: gridResult.veto, context: gridResult.context };
    } else if (gridResult.kind === 'skip-risk-cap') {
      riskCapVeto = { cap: gridResult.cap, context: gridResult.context };
    } else if (gridResult.kind === 'skip-regime') {
      regimeVeto = { reason: gridResult.veto, context: gridResult.context };
    } else if (gridResult.kind === 'skip-guardrail') {
      guardrailVeto = { reason: gridResult.reason, context: gridResult.context };
    } else if (gridResult.kind === 'skip-chase-guard') {
      chaseGuardVeto = gridResult.veto;
    } else if (gridResult.kind === 'skip-knife-guard') {
      knifeGuardVeto = gridResult.veto;
    } else if (gridResult.kind === 'wait' && gridResult.awaitingTrigger !== undefined) {
      awaitingTrigger = gridResult.awaitingTrigger;
    }
    // 'wait' / 'noop' fall through to the tick-snapshot terminal path.
  } else if (
    regimeEntryBlock === null &&
    !forceSellCooled &&
    !lossExitCooled &&
    config.buy.enabled &&
    state.avgEntryPrice === null &&
    !scalars.hasOpenBuy
  ) {
    const gate = evaluateTechnicalsGate(bundle.technicals, config.forceBuyOverride, now);
    if (!gate.ok) {
      // Veto: the confirm streak resets — a flicker back to a buy must satisfy
      // the full window again before an entry.
      entryConfirmCount = 0;
      tvVeto = {
        reason: gate.reason,
        interval: gate.interval,
        intervalsConsulted: gate.intervalsConsulted,
      };
    } else {
      // Gate ALLOWED: advance the consecutive-allow streak (capped at the
      // required reads). Below the threshold the first buy waits one more
      // qualifying tick (technicals-confirming); at or above it the entry
      // proceeds. With the default entryConfirmReads=1 the first allow read
      // satisfies the threshold immediately — today's behaviour, replay diff-0.
      const required = config.technicals.entryConfirmReads;
      // `Math` is banned in strategy code (the Math.random→injected-RNG rule), so
      // cap the streak at `required` with a ternary. Both are plain counts.
      const advanced = state.entryConfirmCount + 1;
      entryConfirmCount = advanced < required ? advanced : required;
      if (entryConfirmCount < required) {
        technicalsConfirming = {
          detail: { reads: entryConfirmCount, required },
        };
      } else {
        const indicatorGate = evaluateIndicatorGate(market, config);
        // Mean-reversion z-score gate runs after the indicator gate; both share
        // the single indicatorVeto channel (only one buy-gate veto surfaces per
        // tick). Both default-disabled, so an un-opted-in profile is unchanged.
        const gateResult = indicatorGate.ok
          ? evaluateMeanReversionGate(market, config)
          : indicatorGate;
        if (!gateResult.ok) {
          indicatorVeto = { reason: gateResult.reason, context: gateResult.context };
        } else {
          // Resolve the no-grid entry budget (fixed amount or percent of
          // equity, downsized to the reserve-cap headroom) before sizing. A
          // typed skip (unconfigured / cap-reached) is surfaced like a filter
          // skip; a budget flows to the per-symbol filter sizing.
          const budget = resolveEntryBudget(
            config,
            ctx.input.account,
            market.symbolInfo.quoteAsset,
            ctx.input.account.deployedQuoteAcrossProfiles,
          );
          // Opt-in regime exposure scaling. Disabled (default) leaves the budget
          // string untouched, so replay is byte-identical; a confirmed-bear scalar
          // of 0 shrinks the budget to '0', which the filter sizing rejects as a
          // logged skip (sit in cash) rather than emitting a buy.
          const exposure = regimeExposure(config, market);
          const result =
            'skip' in budget
              ? budget
              : computeFirstBuyQuantity(
                  exposure.scalar.eq(1)
                    ? budget.budget
                    : new Decimal(budget.budget).mul(exposure.scalar).toString(),
                  market.currentPrice,
                  market.symbolInfo.filters,
                );
          if ('quantity' in result) {
            return {
              kind: 'terminal',
              output: {
                // A first buy fired: clear the loss-exit cooldown stamp and reset
                // the confirm streak so the next cycle starts clean.
                nextState: {
                  ...state,
                  lastLossExitAt: null,
                  lastLossExitReason: null,
                  entryConfirmCount: 0,
                  entryBlocker: null,
                },
                decisions: [buildFirstBuyDecision(ctx.input, result.quantity)],
                logs: preambleLogs,
                // Emit the regime tag only when scaling is on, so the operator can
                // see a reduced-size entry was a regime decision; off keeps the
                // metric set identical to before (golden-replay safe).
                metrics:
                  exposure.regime === 'disabled'
                    ? [metric('tt_tick_buy_path', { symbol: market.symbol })]
                    : [
                        metric('tt_tick_buy_path', { symbol: market.symbol }),
                        metric('tt_regime_exposure', {
                          symbol: market.symbol,
                          regime: exposure.regime,
                        }),
                      ],
              },
            };
          }
          skipReason = result.skip;
        }
      }
    }
  }

  // One metric per tick outcome: a risk-cap veto is its own typed counter so a
  // dashboard distinguishes "an opted-in cap blocked an add" from a filter
  // rejection or a do-nothing tick; skipped counts a filter-rejected buy;
  // pure-path counts ticks with nothing to do.
  const metrics = forceSellCooled
    ? [forceSellCooldownBlock(market.symbol, state).metric]
    : lossExitCooled
      ? [lossCooldownBlock(market.symbol, state).metric]
      : guardrailVeto !== null
        ? [
            metric('tt_discovery_guardrail_veto', {
              symbol: market.symbol,
              reason: guardrailVeto.reason,
            }),
          ]
        : chaseGuardVeto !== null
          ? [metric('tt_discovery_chase_guard_veto', { symbol: market.symbol })]
          : knifeGuardVeto !== null
            ? [metric('tt_discovery_knife_guard_veto', { symbol: market.symbol })]
            : regimeEntryBlock !== null
              ? [metric('tt_regime_exit_entry_block', { symbol: market.symbol })]
              : regimeVeto !== null
                ? [
                    metric('tt_regime_filter_veto', {
                      symbol: market.symbol,
                      reason: regimeVeto.reason,
                    }),
                  ]
                : riskCapVeto !== null
                  ? [metric('tt_risk_cap_veto', { symbol: market.symbol, cap: riskCapVeto.cap })]
                  : skipReason === null
                    ? [metric('tt_tick_pure_path', { symbol: market.symbol })]
                    : [
                        metric('tt_first_buy_skipped', {
                          symbol: market.symbol,
                          reason: skipReason,
                        }),
                      ];
  // Veto logs rebase on preambleLogs. `technicals-no-signal` /
  // `indicator-unavailable` sit at debug (expected cold-boot state); other
  // vetoes are info — they answer "why did we never buy?" during triage.
  // Signal-derived fields appear only on the branch where a signal exists.
  let logs: readonly LogEntry[] = preambleLogs;
  if (forceSellCooled) {
    // Suppressed a fresh first entry while the force-sell re-entry cooldown is
    // still active. forceSellCooled is only set when flat, so no gate ran and
    // none of the veto locals below are populated this tick.
    logs = [...preambleLogs, forceSellCooldownBlock(market.symbol, state).log];
  }
  if (lossExitCooled) {
    // Suppressed a fresh first entry while the loss-exit re-entry cooldown is
    // still active. Like forceSellCooled, only set when flat, so no gate ran.
    logs = [...preambleLogs, lossCooldownBlock(market.symbol, state).log];
  }
  if (tvVeto !== null) {
    const level: LogEntry['level'] = tvVeto.reason === 'technicals-no-signal' ? 'debug' : 'info';
    const baseContext = {
      symbol: market.symbol,
      reason: tvVeto.reason,
      interval: tvVeto.interval,
      useOnlyWithinMin: bundle.technicals.config.useOnlyWithinMin,
      ifExpires: bundle.technicals.config.ifExpires,
      intervalsConsulted: tvVeto.intervalsConsulted,
    };
    const signal =
      bundle.technicals.signals.find((s) => s.interval === tvVeto.interval)?.signal ?? null;
    let context: LogEntry['context'] = baseContext;
    if (signal !== null) {
      const rawAge = now - signal.receivedAtMs;
      context = {
        ...baseContext,
        receivedAtMs: signal.receivedAtMs,
        recommendation: signal.recommendation,
        ageMs: rawAge < 0 ? 0 : rawAge,
      };
    }
    logs = [...preambleLogs, log(level, 'tt-technicals-gate-veto', context)];
  }
  if (technicalsConfirming !== null) {
    // Gate allowed but the confirm streak is short of the required reads, so the
    // first buy waits another qualifying tick. Info: answers "why didn't it buy
    // on the first green reading?" during triage.
    logs = [
      ...preambleLogs,
      log('info', 'tt-technicals-confirming', {
        ...technicalsConfirming.detail,
        symbol: market.symbol,
      }),
    ];
  }
  if (indicatorVeto !== null) {
    const level: LogEntry['level'] =
      indicatorVeto.reason === 'indicator-unavailable' ? 'debug' : 'info';
    // Fixed keys last so symbol / reason (the stable log contract) win.
    logs = [
      ...preambleLogs,
      log(level, 'tt-indicator-gate-veto', {
        ...indicatorVeto.context,
        symbol: market.symbol,
        reason: indicatorVeto.reason,
      }),
    ];
  }
  if (riskCapVeto !== null) {
    // Fixed keys last so symbol / reason (the stable log contract) win.
    logs = [
      ...preambleLogs,
      log('info', 'tt-risk-cap-veto', {
        ...riskCapVeto.context,
        symbol: market.symbol,
        reason: riskCapVeto.cap,
      }),
    ];
  }
  if (regimeVeto !== null) {
    // regime-unavailable is the cold-window case (expected briefly at boot);
    // regime-downtrend answers "why did averaging stop?" during triage.
    logs = [
      ...preambleLogs,
      log(regimeVeto.reason === 'regime-unavailable' ? 'debug' : 'info', 'tt-regime-filter-veto', {
        ...regimeVeto.context,
        symbol: market.symbol,
        reason: regimeVeto.reason,
      }),
    ];
  }
  if (regimeEntryBlock !== null) {
    // A regime gate held a fresh entry back. Two causes, logged apart: the
    // require-uptrend gate (no confirmed bull) vs the bear block / cash-rotation
    // (confirmed downtrend). Answers "why didn't it open / re-enter?".
    logs = [
      ...preambleLogs,
      log(
        'info',
        regimeRequireUptrend ? 'tt-regime-require-uptrend-blocked' : 'tt-regime-exit-entry-blocked',
        { ...regimeEntryBlock, symbol: market.symbol },
      ),
    ];
  }
  if (guardrailVeto !== null) {
    // A discovery entry was refused for lacking a hard stop. WARN: the operator
    // armed enterOnAdd but left the safety net off — actionable misconfiguration,
    // not a routine veto. Fixed keys last so symbol / reason win on collision.
    logs = [
      ...preambleLogs,
      log('warn', 'tt-discovery-guardrail-veto', {
        ...guardrailVeto.context,
        symbol: market.symbol,
        reason: guardrailVeto.reason,
      }),
    ];
  }
  if (chaseGuardVeto !== null) {
    // A discovery entry was held back for chasing a coin near its 24h high. Info:
    // answers "why didn't the auto pick buy?" during triage.
    logs = [
      ...preambleLogs,
      log('info', 'tt-discovery-chase-guard', { ...chaseGuardVeto, symbol: market.symbol }),
    ];
  }
  if (knifeGuardVeto !== null) {
    // A discovery entry was held back because its recent window is still falling.
    logs = [
      ...preambleLogs,
      log('info', 'tt-discovery-knife-guard', { ...knifeGuardVeto, symbol: market.symbol }),
    ];
  }
  // Resolve the single structured "why no buy" reason from the veto locals
  // collected above. Null when nothing was blocking (e.g. a held position with
  // no pending entry, or a flat symbol whose grid returned plain noop). Written
  // into nextState so the worker can diff it across ticks and the web can render
  // a plain-language status line.
  const entryBlocker = resolveEntryBlocker({
    forceSellCooled,
    forceSellDetail:
      forceSellCooled && state.forceSellCooldownUntilMs !== null
        ? { cooldownUntilMs: state.forceSellCooldownUntilMs }
        : undefined,
    lossExitCooled,
    lossDetail: lossExitCooled
      ? { minutesLeft: lossCooldownMinutesLeft(state, config, now) }
      : undefined,
    technicalsConfirming,
    regimeEntryBlock,
    regimeRequireUptrend,
    regimeVeto,
    riskCapVeto,
    guardrailVeto,
    chaseGuardVeto,
    knifeGuardVeto,
    tvVeto:
      tvVeto !== null
        ? {
            reason: tvVeto.reason,
            detail: ((): Readonly<Record<string, unknown>> => {
              const signal =
                bundle.technicals.signals.find((s) => s.interval === tvVeto.interval)?.signal ??
                null;
              if (signal === null) return { interval: tvVeto.interval };
              const rawAge = now - signal.receivedAtMs;
              return {
                interval: tvVeto.interval,
                recommendation: signal.recommendation,
                ageMs: rawAge < 0 ? 0 : rawAge,
              };
            })(),
          }
        : null,
    indicatorVeto,
    awaitingTrigger,
    skipReason,
  });
  return {
    kind: 'terminal',
    output: {
      // Persist the confirm streak on every fall-through terminal so it never
      // goes stale: an ALLOW tick that did not yet reach the threshold carries
      // its advanced count forward; a veto or no-position tick carries 0.
      // When the timeout cancelled a flat grid entry, also clear the grid index:
      // a flat currentGridTradeIndex=0 is the "level-0 emitted, not filled" shape
      // and the level-0 re-entry needs currentGridTradeIndex===null. Without this
      // the cancelled grid profile wedges flat with no order and never re-enters
      // (the orphan-reset never clears index 0). Mirrors the position-adapter
      // full-exit reset. Gated on a fired timeout, so default-off stays identical.
      nextState: {
        ...state,
        entryConfirmCount,
        entryBlocker,
        ...(entryTimeoutCancels.length > 0 ? { currentGridTradeIndex: null } : {}),
      },
      decisions: [
        ...entryTimeoutCancels,
        ...regimeEntryBlockCancels,
        {
          type: 'emit-event',
          eventType: 'tick-snapshot',
          payload: { symbol: market.symbol, currentPrice: market.currentPrice, tsMs: now },
        },
      ],
      logs,
      metrics,
    },
  };
};

const BRANCHES: readonly BranchHandler[] = [
  applyDisabledClearBranch,
  overrideBranch,
  autoTriggerBuyBranch,
  disabledGateBranch,
  lbpClearBranch,
  sellGateBranch,
  buyAndSnapshotBranch,
];

/**
 * Strategy entry-point body. Pure: no I/O, no `Date.now`, no `Math.random`;
 * the worker injects clock/RNG so replays reproduce ticks byte-for-byte.
 *
 * Dispatches the fixed-order BRANCHES chain: each branch either terminates
 * the tick or hands an updated (state, preambleLogs) carry to the next. The
 * tuple order encodes the strategy's precedence; `buyAndSnapshotBranch`
 * always terminates, so the loop never falls off the end.
 *
 * Override consumption is atomic at the worker (`bundle-builder` uses
 * `GETDEL`), so the override row this tick observes is gone by the time the
 * strategy runs; a retry of the tick will not see it again.
 */
// Coerce the nullable position scalars to their contract `null`. A persisted
// state body can omit a nullable key that has no schema `.default` (the body is
// re-parsed only across a schemaVersion hop, and an at-version row loads raw),
// so a field like `avgEntryPrice` can arrive `undefined`. The position guards
// below compare `=== null` / `!== null`, and `undefined` slips past both, so a
// flat symbol would be mis-read as holding a position: that blocks its first
// buy and spams the force-sell parse-fail path. Normalising once at entry makes
// a missing key behave as the contract `null` it stands for; a tick that then
// commits a full nextState re-writes the key so the row stops drifting.
export const normalizeTickState = (s: TTState): TTState => {
  const avgEntryPrice = s.avgEntryPrice ?? null;
  return {
    ...s,
    avgEntryPrice,
    heldQuantity: s.heldQuantity ?? null,
    highSinceBuy: s.highSinceBuy ?? null,
    breakEvenArmed: s.breakEvenArmed ?? false,
    currentGridTradeIndex: s.currentGridTradeIndex ?? null,
    autoTriggerBuyAtMs: s.autoTriggerBuyAtMs ?? null,
    disabledUntilMs: s.disabledUntilMs ?? null,
    bullAddCount: s.bullAddCount ?? null,
    lastBullAddPrice: s.lastBullAddPrice ?? null,
    discoveryEntry: s.discoveryEntry ?? false,
    entryAtMs: s.entryAtMs ?? null,
    // firstSeen is position-scoped: a flat position (avgEntryPrice null) cleared
    // outside clearedSellPosition (e.g. the fill-adopter) must not carry a stale
    // confirm-window stamp into the next entry. Cooldown is NOT cleared here: it
    // must survive a flat position to suppress buy-back into the same downturn.
    forceSellFirstSeenAtMs: avgEntryPrice === null ? null : (s.forceSellFirstSeenAtMs ?? null),
    forceSellCooldownUntilMs: s.forceSellCooldownUntilMs ?? null,
    // Loss-exit cooldown survives a flat position (same as the force-sell
    // cooldown), so it is NOT cleared on `avgEntryPrice === null`.
    lastLossExitAt: s.lastLossExitAt ?? null,
    lastLossExitReason: s.lastLossExitReason ?? null,
    entryConfirmCount: s.entryConfirmCount ?? 0,
    entryBlocker: s.entryBlocker ?? null,
    protectiveStopBlocker: s.protectiveStopBlocker ?? null,
  };
};

export const computeTick = (
  rawInput: TickInput<TTConfig, TTState, TTBundle>,
): TickOutput<TTState> => {
  const input = { ...rawInput, state: normalizeTickState(rawInput.state) };
  const scalars = buildScalars(input);
  let state: TTState = input.state;
  let preambleLogs: readonly LogEntry[] = [];
  for (const branch of BRANCHES) {
    const outcome = branch({ input, scalars, state, preambleLogs });
    if (outcome.kind === 'terminal') return outcome.output;
    if (outcome.kind === 'mutate') {
      state = outcome.state;
      preambleLogs = outcome.preambleLogs;
    }
  }
  /* v8 ignore start -- reason: the final branch (buyAndSnapshotBranch) always returns a terminal outcome, so the loop never falls through; this throw guards a future branch-list edit */
  throw new Error('computeTick: buyAndSnapshotBranch must terminate the chain');
  /* v8 ignore stop -- reason: end of the unreachable loop-terminator guard above */
};

/**
 * Per-tick indicator gauges for the configured interval. The worker's
 * IndicatorComputer publishes RSI/SMA/EMA on each closed candle; surfacing
 * them as metrics gives operators indicator visibility on each tick.
 * Returns [] when the indicator cache has not been populated yet
 * (cold worker, or a candle window shorter than the indicator period).
 * Applied uniformly to every tick outcome by the `trailingTrade.tick`
 * wrapper so the gauge series has no per-decision sampling gaps.
 */
export const indicatorMetrics = (
  market: MarketSnapshot,
  interval: TTConfig['candleInterval'],
): readonly MetricEntry[] => {
  const snap = market.indicatorsByInterval?.[interval];
  if (snap === undefined) return [];
  const tags = { symbol: market.symbol, interval };
  const out: MetricEntry[] = [];
  const push = (name: string, raw: string | null): void => {
    if (raw === null) return;
    const value = Number(raw);
    if (Number.isFinite(value)) out.push({ name, value, tags });
  };
  push('tt_indicator_rsi14', snap.rsi14);
  push('tt_indicator_sma20', snap.sma20);
  push('tt_indicator_ema20', snap.ema20);
  return out;
};

interface LbpClearResult {
  readonly state: TTState;
  readonly log: LogEntry;
}

/**
 * Returns a state with `avgEntryPrice` cleared plus a log entry recording
 * the clear, when the configured `avgEntryPriceRemoveThreshold` has
 * tripped AND there is no open BUY AND the operator holds no position
 * in the base asset. Returns null otherwise.
 *
 * Threshold semantics: a decimal multiplier in (0, 1]. 0.95 means
 * "clear when price drops 5% below entry". The schema constrains the
 * value at parse time; this helper's degenerate-value guards are
 * belt-and-braces against an upstream skip of validation. Malformed
 * inputs (e.g. Decimal parse failure on a hand-edited db row) skip
 * the clear and emit a warn LogEntry so the operator sees the failure
 * rather than silent inaction.
 */
const maybeClearAvgEntryPrice = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  state: TTState,
): LbpClearResult | null => {
  if (state.avgEntryPrice === null) return null;
  const thresholdStr = input.config.buy.avgEntryPriceRemoveThreshold;
  if (!thresholdStr || thresholdStr.trim() === '' || thresholdStr === '0') return null;
  // Surface any parse failure via the returned LogEntry (state unchanged) so the
  // caller's bookkeeping stays symmetric with the "clear fired" path and the
  // operator sees a warn rather than silent inaction. Parsed in declared order so
  // the reported `err` is the first failing field's, matching the prior single
  // try/catch.
  const parseFail = (err: string): LbpClearResult => ({
    state,
    log: log('warn', 'tt-lbp-clear-parse-failed', {
      err,
      thresholdStr,
      avgEntryPrice: state.avgEntryPrice,
      currentPrice: input.market.currentPrice,
    }),
  });
  const thresholdParse = parseDecimal(thresholdStr);
  if (!thresholdParse.ok) return parseFail(thresholdParse.err);
  const lbpParse = parseDecimal(state.avgEntryPrice);
  if (!lbpParse.ok) return parseFail(lbpParse.err);
  const priceParse = parseDecimal(input.market.currentPrice);
  if (!priceParse.ok) return parseFail(priceParse.err);
  const threshold = thresholdParse.value;
  const lbp = lbpParse.value;
  const price = priceParse.value;
  if (threshold.lte(0) || threshold.gt(1)) return null;
  if (lbp.lte(0) || price.lte(0)) return null;
  if (price.gt(lbp.times(threshold))) return null;
  if (hasOpenBuyForSymbol(input.openOrders, input.market.symbol)) return null;
  const baseAsset = input.market.symbolInfo.baseAsset;
  const balance = input.account.balances[baseAsset];
  // Balance.free / .locked arrive as Decimal from the snapshot loader; only
  // the symbol-filter minQty is still a wire string that needs parsing.
  const free: Decimal = balance?.free ?? new Decimal(0);
  const locked: Decimal = balance?.locked ?? new Decimal(0);
  // Symmetric with the threshold/price/lbp parse-fail path above: surface the
  // parse error via a returned LogEntry rather than a silent no-op so the
  // operator sees the failure when clear conditions appear met but no clear lands.
  const minQtyParse = parseDecimal(input.market.symbolInfo.filters.minQty);
  if (!minQtyParse.ok) {
    return {
      state,
      log: log('warn', 'tt-lbp-clear-balance-parse-failed', {
        err: minQtyParse.err,
        symbol: input.market.symbol,
        baseAsset,
        minQty: input.market.symbolInfo.filters.minQty,
      }),
    };
  }
  const minQty = minQtyParse.value;
  if (free.plus(locked).gte(minQty)) return null;
  return {
    // Resetting `currentGridTradeIndex` together with `avgEntryPrice`
    // keeps grid-mode state coherent: the next entry tick re-fires
    // level 0 instead of stranding the profile in the
    // `(lbp=null, idx=N)` orphan state where every gate misses.
    state: {
      ...state,
      avgEntryPrice: null,
      currentGridTradeIndex: null,
      ...clearedAddTracking(),
    },
    log: log('info', 'tt-lbp-cleared', {
      symbol: input.market.symbol,
      avgEntryPrice: state.avgEntryPrice,
      currentPrice: input.market.currentPrice,
      threshold: thresholdStr,
    }),
  };
};
