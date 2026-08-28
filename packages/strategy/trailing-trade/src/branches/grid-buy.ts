import { roundToStep, toFixedStep } from '@app/money';
import { accountEquity, log } from '@app/strategy-core';
import type { Decision, LogEntry, TickInput } from '@app/strategy-core';
import { gridBuyClientOrderId } from '../client-order-id.js';
import { buildGridBuyDecision } from '../decisions.js';
import { computeFirstBuyQuantity, type FirstBuySkipReason } from '../quantity.js';
import type { TTBundle, TTConfig, TTState } from '../schema.js';
import {
  evaluateEnterOnAddFloor,
  evaluateTechnicalsGate,
  type IntervalConsultation,
  type TVGateVeto,
} from '../technicals-gate.js';
import {
  evaluateIndicatorGate,
  type IndicatorGateContext,
  type IndicatorGateVeto,
} from '../indicator-gate.js';
import { evaluateMeanReversionGate } from '../mean-reversion-gate.js';
import { evaluateRiskCaps, type RiskCap, type RiskCapVeto } from './risk-caps.js';
import { evaluateRegimeFilter, type RegimeVeto } from './regime-filter.js';
import { evaluateRegimeExit } from './regime-exit.js';
import {
  chaseGuard,
  knifeGuard,
  type ChaseGuardVeto,
  type KnifeGuardVeto,
} from './entry-guards.js';
import { safeDecimal } from './safe-decimal.js';

export interface GridBuyEmit {
  readonly kind: 'emit';
  readonly state: TTState;
  readonly decisions: readonly Decision[];
  readonly log: LogEntry;
  readonly level: number;
}
export interface GridBuySkipFilter {
  readonly kind: 'skip-filter';
  readonly skip: FirstBuySkipReason;
}
export interface GridBuySkipTv {
  readonly kind: 'skip-tv';
  readonly veto: TVGateVeto;
  readonly interval: string;
  /** Full per-interval breakdown from `evaluateTechnicalsGate`; threaded through
   *  to the audit log so a grid-entry veto carries the same observability
   *  surface as a single-buy veto. */
  readonly intervalsConsulted: readonly IntervalConsultation[];
}
export interface GridBuySkipIndicator {
  readonly kind: 'skip-indicator';
  readonly veto: IndicatorGateVeto;
  readonly context: IndicatorGateContext;
}
export interface GridBuySkipRiskCap {
  readonly kind: 'skip-risk-cap';
  readonly cap: RiskCap;
  readonly context: RiskCapVeto['context'];
}
export interface GridBuySkipRegime {
  readonly kind: 'skip-regime';
  readonly veto: RegimeVeto;
  readonly context: Readonly<Record<string, unknown>>;
}
/**
 * Fail-closed refusal: a discovery entry (armed `enterOnAdd` hint on a flat
 * first entry) was asked to open without a valid hard stop. A discovery pick is
 * a momentum/breakout bet that fails by reversing; arming it with no stop-loss
 * is a money incinerator on exactly the trades that go wrong, so the entry is
 * refused rather than placed. The caller logs it so the refusal is observable.
 */
export interface GridBuySkipGuardrail {
  readonly kind: 'skip-guardrail';
  readonly reason: 'discovery-no-stop';
  readonly context: Readonly<Record<string, unknown>>;
}
/**
 * Discovery anti-chase deferral: the entry-hint carried a 24h high and an
 * armed guard, and the entry was vetoed for chasing a coin near its high
 * (`chase`) or buying into a still-falling window (`knife`). Like the other skip
 * results the entry places no order; the hint stays armed so the next tick
 * re-evaluates once the price cools or the slide stops.
 */
export interface GridBuySkipChaseGuard {
  readonly kind: 'skip-chase-guard';
  readonly veto: ChaseGuardVeto;
}
export interface GridBuySkipKnifeGuard {
  readonly kind: 'skip-knife-guard';
  readonly veto: KnifeGuardVeto;
}
export interface GridBuyWait {
  readonly kind: 'wait';
  /**
   * Set only on the lowest-price first-buy deferral: the window low, the
   * configured level-0 trigger multiplier, and the current price that has not
   * yet dipped to `windowLow × trigger`. Carried out so the caller can surface
   * `awaiting-trigger-price` with the explaining numbers instead of a silent
   * wait. Absent on the resting-order / in-flight waits (nothing to explain —
   * an order is already on the book).
   */
  readonly awaitingTrigger?: {
    readonly windowLow: string;
    readonly triggerPercentage: string;
    readonly currentPrice: string;
  };
}
export interface GridBuyNoop {
  readonly kind: 'noop';
}
export type GridBuyResult =
  | GridBuyEmit
  | GridBuySkipFilter
  | GridBuySkipTv
  | GridBuySkipIndicator
  | GridBuySkipRiskCap
  | GridBuySkipRegime
  | GridBuySkipGuardrail
  | GridBuySkipChaseGuard
  | GridBuySkipKnifeGuard
  | GridBuyWait
  | GridBuyNoop;

/**
 * Lowest candle low over the last `candleLimit` candles of the configured
 * interval, or null when no candles are available. Drives the
 * 'lowest-price' first-buy trigger. The window length is a plain count; only
 * the price comparison crosses the Decimal boundary.
 */
const lowestLowInWindow = (
  market: TickInput<TTConfig, TTState, TTBundle>['market'],
  config: TTConfig,
): ReturnType<typeof safeDecimal> => {
  const candles = market.candlesByInterval[config.candleInterval];
  if (candles === undefined || candles.length === 0) return null;
  // `Math` is banned in strategy packages (the Math.random→injected-RNG rule),
  // so clamp the window with a ternary. Both operands are plain counts.
  const count = config.buy.candleLimit < candles.length ? config.buy.candleLimit : candles.length;
  let min: ReturnType<typeof safeDecimal> = null;
  for (const candle of candles.slice(candles.length - count)) {
    const low = safeDecimal(candle.low);
    if (low === null) continue;
    if (min === null || low.lt(min)) min = low;
  }
  return min;
};

/**
 * Resolve which grid level (if any) should fire this tick and assemble
 * the corresponding decisions (cancel-order for stale lower levels +
 * place-order for the target level).
 *
 *   - **Entry** (`avgEntryPrice === null && currentGridTradeIndex === null`):
 *     target = level 0. TV gate applies because the entry is the only
 *     level that opens a position from flat — unless `forceTvOpen` is set
 *     for an operator- or timer-forced re-entry. A 'lowest-price' basis
 *     defers this entry to the window low, but an armed `enterOnAdd` hint
 *     bypasses that wait so a discovery momentum pick enters on the add; the
 *     entry then still passes the relaxed technicals floor, so a fresh
 *     STRONG_SELL still vetoes it.
 *   - **Promotion** (`avgEntryPrice !== null && currentGridTradeIndex !== null
 *     && index + 1 < gridLevels.length`): target = index + 1 IF current
 *     price has dropped to `avgEntryPrice * gridLevels[index+1]
 *     .triggerPercentage`. TV gate does not apply: promotions are an
 *     averaging-down behaviour the operator opted into when configuring
 *     the ladder, not a fresh directional bet.
 *
 * The indicator gate (RSI ceiling, SMA/EMA bias) applies to BOTH entry
 * and promotions — unlike the TV gate — because an oversold / MA-bias
 * precondition is meaningful for an averaging-down add, not only a fresh
 * entry. It is disabled by default, so configs that have not opted in are
 * unaffected. Consequence the operator owns: a `price-above-*` momentum
 * bias will veto every promotion once price falls below the MA (which a
 * promotion trigger implies), so a momentum-biased ladder stops averaging
 * down. That is the bias doing its job, not a bug — but it means a
 * momentum bias and a deep grid ladder are contradictory by design.
 *   - **Final level held**: returns `noop` (nothing further to promote).
 *   - **Open BUY matching the target level's stable clientOrderId**:
 *     returns `wait` (the same level is already in flight; do not
 *     double-emit).
 *   - **Open BUY on the symbol with a non-matching clientOrderId** (stale
 *     LIMIT from a prior level or a manual order): emit cancel-order(s)
 *     for those alongside the target place-order so promotion never
 *     leaves a stranded resting order on the book.
 */
export const evaluateGridBuy = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  state: TTState,
  now: number,
  forceTvOpen = false,
): GridBuyResult => {
  const { config, market, openOrders, bundle, profile, account } = input;
  const levels = config.buy.gridLevels;

  let targetLevel: number | null = null;
  let isEntry = false;
  if (state.avgEntryPrice === null && state.currentGridTradeIndex === null) {
    isEntry = true;
    // The 'lowest-price' basis defers the level-0 entry until price returns to
    // the window low × the level-0 trigger; 'immediate' (default) enters now.
    // An armed `enterOnAdd` discovery hint owns the full "enter on a discovery
    // add" promise, so it skips the window-low wait: a momentum pick trades
    // above its window low and would otherwise wait forever.
    if (
      config.buy.firstBuyTriggerBasis === 'lowest-price' &&
      bundle.entryHint?.enterOnAdd !== true
    ) {
      const lvl0 = levels[0];
      const low = lowestLowInWindow(market, config);
      const trigger = lvl0 === undefined ? null : safeDecimal(lvl0.triggerPercentage);
      const price = safeDecimal(market.currentPrice);
      if (low === null || trigger === null || price === null) return { kind: 'noop' };
      if (price.lte(low.mul(trigger))) {
        targetLevel = 0;
      } else {
        // The XPL fix: carry the wait context out so the caller can explain the
        // deferral as `awaiting-trigger-price` instead of a silent no-op.
        return {
          kind: 'wait',
          awaitingTrigger: {
            windowLow: low.toString(),
            /* v8 ignore next -- reason: a non-null trigger proves lvl0 is defined (the grid path enforces gridLevels.length > 0), so the raw multiplier string is always read; the parsed fallback is an unreachable noUncheckedIndexedAccess guard */
            triggerPercentage: lvl0?.triggerPercentage ?? trigger.toString(),
            currentPrice: market.currentPrice,
          },
        };
      }
    } else {
      targetLevel = 0;
    }
  } else if (
    state.avgEntryPrice !== null &&
    state.currentGridTradeIndex !== null &&
    state.currentGridTradeIndex + 1 < levels.length
  ) {
    // A discovery single-entry holds at level 0 and never averages down: a
    // discovery pick is a momentum/breakout bet, and a failed breakout that
    // reverses is the expected failure mode — adding size into it is the worst
    // reaction. Suppress the promotion entirely (the resting-order-trail and
    // first-entry branches are unaffected).
    if (state.discoveryEntry === true) return { kind: 'noop' };
    const nextLevel = state.currentGridTradeIndex + 1;
    const nextLevelCfg = levels[nextLevel];
    /* v8 ignore start -- reason: the enclosing branch proves currentGridTradeIndex + 1 < levels.length, so this index is always defined (noUncheckedIndexedAccess guard) */
    if (nextLevelCfg === undefined) return { kind: 'noop' };
    /* v8 ignore stop -- reason: end of the unreachable noUncheckedIndexedAccess guard above */
    const lbp = safeDecimal(state.avgEntryPrice);
    const trigger = safeDecimal(nextLevelCfg.triggerPercentage);
    const price = safeDecimal(market.currentPrice);
    if (lbp === null || trigger === null || price === null) {
      return { kind: 'noop' };
    }
    if (price.lte(lbp.mul(trigger))) {
      targetLevel = nextLevel;
    }
  } else if (state.avgEntryPrice === null && state.currentGridTradeIndex !== null) {
    // A level was emitted (cgti set) but not yet filled (lbp still null): its
    // resting stop-limit order should be trailed DOWN as price falls ("buy
    // the lowest"). Neither the entry branch (needs cgti===null) nor the
    // promotion branch (needs lbp!==null) reaches the re-pricing block in this
    // state, so without this the resting order is never trailed. Target
    // the level ONLY when an order is actually resting on it; the resting-order
    // block below then re-prices that order and never places a second, so a
    // level is never re-fired before its fill is adopted.
    const restingLevel = state.currentGridTradeIndex;
    const restingId = gridBuyClientOrderId(profile.id, market.symbol, restingLevel);
    const hasResting = openOrders.some(
      (o) => o.symbol === market.symbol && o.side === 'BUY' && o.clientOrderId === restingId,
    );
    if (hasResting) targetLevel = restingLevel;
  }
  if (targetLevel === null) {
    return { kind: 'noop' };
  }

  const level = levels[targetLevel];
  if (level === undefined) return { kind: 'noop' };
  const expectedClientOrderId = gridBuyClientOrderId(profile.id, market.symbol, targetLevel);
  const openBuys = openOrders.filter((o) => o.symbol === market.symbol && o.side === 'BUY');

  // Buy stop-limit prices for this level (undefined for a MARKET level).
  // Computed before the resting-order check so a resting stop-limit can be
  // trailed DOWN as price falls. The schema enforces the stop/limit pairing,
  // so one non-empty implies both.
  let stopLimit: { readonly stopPrice: string; readonly price: string } | undefined;
  if (level.stopPricePercentage !== '' && level.limitPricePercentage !== '') {
    const entryPrice = safeDecimal(market.currentPrice);
    const stopPct = safeDecimal(level.stopPricePercentage);
    const limitPct = safeDecimal(level.limitPricePercentage);
    const tick = safeDecimal(market.symbolInfo.filters.tickSize);
    if (
      entryPrice !== null &&
      stopPct !== null &&
      limitPct !== null &&
      tick !== null &&
      tick.gt(0)
    ) {
      stopLimit = {
        stopPrice: toFixedStep(roundToStep(entryPrice.mul(stopPct), tick), tick),
        price: toFixedStep(roundToStep(entryPrice.mul(limitPct), tick), tick),
      };
    }
  }

  const resting = openBuys.find((o) => o.clientOrderId === expectedClientOrderId);
  if (resting !== undefined) {
    // A MARKET order in flight fills on its own — nothing to re-price.
    if (stopLimit === undefined) return { kind: 'wait' };
    // Never re-price a partially-filled resting order: cancelling it would
    // strand the already-bought quantity (the fill-adopter only adopts a
    // terminal FILLED). Let it run to completion.
    const executed = safeDecimal(resting.executedQty);
    if (executed !== null && executed.gt(0)) return { kind: 'wait' };
    // Trail DOWN only ("buy the lowest"): re-place when the recomputed stop
    // is strictly lower than the resting stop. A higher-or-equal stop means
    // price rose toward the trigger — keep the resting order so it can fill.
    if (resting.stopPrice === undefined) return { kind: 'wait' };
    const restingStop = safeDecimal(resting.stopPrice);
    const newStop = safeDecimal(stopLimit.stopPrice);
    if (restingStop === null || newStop === null || newStop.gte(restingStop)) {
      return { kind: 'wait' };
    }
    // Min-drift gate: a tiny downward drift re-places the resting order every
    // tick on 1-3s noise (cancel + place churn). When armed (>0), only re-price
    // once the drop reaches restingStop × threshold; default '0' disables it so
    // the trail-down stays byte-identical.
    const minDrift = safeDecimal(config.buy.gridRepriceMinDriftPercent);
    if (
      minDrift !== null &&
      minDrift.gt(0) &&
      restingStop.minus(newStop).lt(restingStop.mul(minDrift))
    ) {
      return { kind: 'wait' };
    }
    // Drifted lower — fall through to cancel the resting order (staleCancels
    // cancels every open BUY) and re-place at the new prices.
  }

  // The discovery hint is armed for every discovery-managed symbol; its
  // `enterOnAdd` flag says whether this profile relaxes the buy gate on a
  // discovery add. `isEntry` is only set on the flat first-entry branch above, so
  // neither of the gates below can fire for a promotion or a resting-order reprice.
  const hint = bundle.entryHint;
  const enterOnAddArmed = isEntry && hint?.enterOnAdd === true;

  // Fail-closed: an enterOnAdd entry skips short-interval confirmation, so it
  // MUST carry a valid hard stop. The stop-loss multiplier must parse to a
  // Decimal in (0, 1] (a real loss-cut below entry). Empty / '0' / out-of-range
  // means no stop, and arming an immediate momentum entry with no stop is a money
  // incinerator on the trades that fail. A plain discovery entry (enterOnAdd off,
  // still gated by the normal buy path) does not need this guardrail.
  if (enterOnAddArmed) {
    const stopStr = config.sell.stopLossPercentage;
    const stop = safeDecimal(stopStr);
    if (stop === null || !stop.gt(0) || !stop.lte(1)) {
      return {
        kind: 'skip-guardrail',
        reason: 'discovery-no-stop',
        context: { symbol: market.symbol, stopLossPercentage: stopStr },
      };
    }
  }

  // Anti-chase guards (default-off) apply to ANY discovery entry — an enterOnAdd
  // entry OR a lowest-price wait that just triggered — since the cron refreshes
  // the 24h high + guard params into the hint each cycle. An off knob or an absent
  // high24h returns null and the entry proceeds. Chase before knife: "already ran"
  // is the dominant reason to skip when both could apply.
  if (isEntry && hint != null) {
    const chaseVeto = chaseGuard(
      market.currentPrice,
      hint.high24h,
      hint.maxDistanceFrom24hHighPercent,
    );
    if (chaseVeto !== null) return { kind: 'skip-chase-guard', veto: chaseVeto };
    const closedCandles = market.candlesByInterval[config.candleInterval]?.filter(
      (c) => c.isClosed,
    );
    const knifeVeto = knifeGuard(closedCandles, hint.knifeCandles, hint.knifeDropPercent);
    if (knifeVeto !== null) return { kind: 'skip-knife-guard', veto: knifeVeto };
  }

  // `forceTvOpen` skips the entry TV gate for an operator- or timer-forced
  // re-entry (trigger-buy override, auto-trigger-buy re-arm); promotions
  // never consult the TV gate regardless.
  if (isEntry && !forceTvOpen) {
    // A discovery `enterOnAdd` hint relaxes ONLY this first-entry technicals gate
    // to a Strong-Sell floor. It does not touch the indicator gate, the regime
    // filter, or any promotion below — those downside guards stay in force.
    const gate =
      bundle.entryHint?.enterOnAdd === true
        ? evaluateEnterOnAddFloor(bundle.technicals, config.forceBuyOverride, now)
        : evaluateTechnicalsGate(bundle.technicals, config.forceBuyOverride, now);
    if (!gate.ok) {
      return {
        kind: 'skip-tv',
        veto: gate.reason,
        interval: gate.interval,
        intervalsConsulted: gate.intervalsConsulted,
      };
    }
  }

  const indicatorGate = evaluateIndicatorGate(market, config);
  // The mean-reversion gate applies to every buy emission, same as the
  // indicator gate (grid entry + averaging-down promotions, not just the
  // non-grid first buy); both surface through the one skip-indicator channel.
  const gateResult = indicatorGate.ok ? evaluateMeanReversionGate(market, config) : indicatorGate;
  if (!gateResult.ok) {
    return { kind: 'skip-indicator', veto: gateResult.reason, context: gateResult.context };
  }

  // Regime filter applies ONLY to promotions (averaging-down adds), never the
  // first entry or the sell side. A promotion is any buy while a position is
  // already open (avgEntryPrice set); the entry and the resting-entry-reprice
  // paths both have avgEntryPrice === null and are exempt. Halts the add when
  // the daily trend is down so the ladder stops deepening into a bear.
  if (state.avgEntryPrice !== null) {
    // evaluateRegimeFilter tolerates a disabled/missing regime block (returns
    // ok), so this is safe on raw stored configs that predate the field.
    const regime = evaluateRegimeFilter(market, config);
    // Fail-closed: any not-ok result halts the promotion. The `?? 'regime-
    // unavailable'` default keeps that true even if a future result shape omits
    // the reason — never fall through to placing the add on an unevaluated gate.
    if (!regime.ok) {
      /* v8 ignore start -- reason: evaluateRegimeFilter always sets reason+context on a not-ok result; these ?? fallbacks guard a hypothetical future result shape */
      return {
        kind: 'skip-regime',
        veto: regime.reason ?? 'regime-unavailable',
        context: regime.context ?? {},
      };
      /* v8 ignore stop -- reason: end of the unreachable reason/context fallback above */
    }
    // Cash rotation halts promotions too: a confirmed regime-exit bear stops the
    // ladder deepening even when regime.onBear.suppressPromotion is off, so the
    // exit's "rotate out and stop averaging in" promise holds on its own (e.g.
    // when the held position is dust and the exit sell was skipped).
    const regimeExit = evaluateRegimeExit(market, config);
    if (regimeExit.kind === 'bear') {
      return { kind: 'skip-regime', veto: 'regime-downtrend', context: regimeExit.context };
    }
  }

  // Budget per level = the max purchase amount (the cap the strategy sizes the
  // buy up to); the min floor is enforced inside computeFirstBuyQuantity.
  const result = computeFirstBuyQuantity(
    level.maxPurchaseAmount,
    market.currentPrice,
    market.symbolInfo.filters,
    level.minPurchaseAmount,
  );
  if ('skip' in result) {
    return { kind: 'skip-filter', skip: result.skip };
  }

  // Opt-in risk caps: refuse to open this level when its deployed quote would
  // breach the per-symbol exposure cap, its worst-case loss would breach the
  // per-position loss budget, or the account-wide deployed total would breach
  // the account cap. Evaluated on the sized quantity so the check uses the
  // notional actually committed; the account total is supplied by the worker.
  // Off by default (no cap armed → null).
  const riskVeto = evaluateRiskCaps(
    config,
    state,
    result.quantity,
    market.currentPrice,
    // Optional account-wide field; absent only in minimal unit fixtures, where
    // it defaults to '0' (the account cap is off by default regardless).
    account?.deployedQuoteAcrossProfiles,
    account ? accountEquity(account, market.symbolInfo.quoteAsset).toString() : '0',
  );
  if (riskVeto !== null) {
    return { kind: 'skip-risk-cap', cap: riskVeto.cap, context: riskVeto.context };
  }

  // Cancel every open BUY for the symbol before placing the target level: a
  // stale lower-level order, a manual order, or the resting same-level order
  // we are re-pricing after a downward drift. The reason distinguishes a
  // same-level re-price from a cross-level promotion in the audit trail.
  const staleCancels: Decision[] = openBuys.map((o) => ({
    type: 'cancel-order',
    orderId: o.orderId,
    // Stamp the symbol so the executor can cancel on the exchange even if
    // the local order row was never persisted (a placement the worker made
    // but crashed before writing): the cancel no longer depends on a local
    // lookup succeeding.
    symbol: market.symbol,
    reason:
      o.clientOrderId === expectedClientOrderId
        ? `tt-grid-reprice-l${targetLevel}`
        : `tt-grid-promote-l${targetLevel}`,
  }));

  return {
    kind: 'emit',
    // Stamp the durable discovery marker only on an enterOnAdd entry — the
    // single-momentum-entry treatment (no grid promotions, no pyramid, a
    // time-stop). A plain discovery entry (enterOnAdd off) trades as a normal
    // grid position, so it is left untouched (false/null by default), as are
    // promotions, repricing, and non-hint entries.
    state: {
      ...state,
      currentGridTradeIndex: targetLevel,
      // entryAtMs marks the position open for a time-stop. A discovery entry
      // always stamps it (its time-stop is unconditional). A non-discovery FIRST
      // entry stamps it only when the general time-stop is enabled, so the
      // default-off path leaves it null (byte-identical golden replay). Stamped
      // on `isEntry` only, never a promotion, so the clock runs from the open and
      // averaging-down does not defer it.
      ...(enterOnAddArmed
        ? { discoveryEntry: true, entryAtMs: now }
        : isEntry && config.sell.timeStopBars > 0
          ? { entryAtMs: now }
          : {}),
    },
    decisions: [
      ...staleCancels,
      buildGridBuyDecision(input, result.quantity, targetLevel, stopLimit),
    ],
    log: log('info', 'tt-grid-buy-emit', {
      symbol: market.symbol,
      gridIndex: targetLevel,
      quantity: result.quantity,
      canceledStale: staleCancels.length,
    }),
    level: targetLevel,
  };
};
