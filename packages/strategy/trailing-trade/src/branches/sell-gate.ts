import { freeBalance, log, ownRestingSellBase, sizableBase } from '@app/strategy-core';
import type { Candle, LogEntry, MarketSnapshot, TickInput } from '@app/strategy-core';
import { Decimal } from '@app/money';
import { atr } from '@app/indicators';
import { roundTripFeeFraction } from '../fees.js';
import { protectiveStopClientOrderId } from '../client-order-id.js';
import { buildSellDecision } from '../decisions.js';
import { computeSellQuantity, type SellSkipReason } from '../quantity.js';
import type { ExitBlocker, TTAtrTrailing, TTBundle, TTConfig, TTState } from '../schema.js';
import {
  hasDownsideExitConfigured,
  noExitCandidates,
  resolveExitBlocker,
  type ExitCandidates,
} from '../exit-blocker.js';
import { resolveTTStopLevel } from '../stop-level.js';
import { classifyRegime } from './regime.js';
import { parseDecimal, safeDecimal } from './safe-decimal.js';

/**
 * Bull-hold room dial → ATR multiplier. The operator picks plain "room"; the
 * engine owns the volatility math so "ATR" never reaches the config surface.
 * Looser = wider trail = rides bigger pullbacks but gives back more at the top.
 */
const BULL_HOLD_MULTIPLIER: Readonly<Record<'tight' | 'normal' | 'loose', string>> = {
  tight: '2',
  normal: '3',
  loose: '4',
};

/**
 * Bull-hold ATR multiplier when a confirmed daily bull is holding, else null.
 * Returns null (no widening) unless `regime.onBull.hold.enabled` AND the daily
 * regime classifies `bull`. Reads the regime ONCE per evaluation; tolerant of a
 * missing `regime` block on older config rows (optional chaining ⇒ disabled).
 */
const bullHoldMultiplier = (config: TTConfig, market: MarketSnapshot): string | null => {
  const regime = config.regime;
  const hold = regime?.onBull?.hold;
  if (regime === undefined || hold?.enabled !== true) return null;
  const { regime: verdict } = classifyRegime(market, {
    ma: regime.ma,
    period: regime.period,
    confirmBars: regime.confirmBars,
  });
  if (verdict !== 'bull') return null;
  // The live worker passes RAW stored config (no schema parse), so `room` could
  // be an out-of-enum value on a hand-edited row; fall back to the normal
  // multiplier rather than skipping the trail, matching the web mirror's
  // parseBullHoldParams.
  return BULL_HOLD_MULTIPLIER[hold.room] ?? BULL_HOLD_MULTIPLIER.normal;
};

/**
 * Effective ATR trail multiplier for the current tick.
 *
 *   - bull-hold inactive: the operator's `atrTrailing.multiplier` (existing path).
 *   - bull-hold active, ATR not operator-enabled: the room-mapped bull multiplier.
 *   - both: `max(operator, bull)` so a confirmed bull never TIGHTENS a trail the
 *     operator deliberately set wide.
 *
 * Returns null only when the operator's multiplier is corrupted (atr enabled),
 * so the caller emits the same parse-warn it always did. The bull multiplier
 * comes from a fixed internal map and never fails to parse.
 */
const selectTrailMultiplier = (atrCfg: TTAtrTrailing, bullMult: string | null): Decimal | null => {
  const bull = bullMult === null ? null : safeDecimal(bullMult);
  if (!atrCfg.enabled) return bull;
  const base = safeDecimal(atrCfg.multiplier);
  if (base === null) return null;
  return bull === null ? base : Decimal.max(base, bull);
};

/**
 * Wilder ATR over the trading interval's closed candles, or null when the
 * window is too short (< period+1) or absent. Closed-only mirrors the momentum
 * strategy's window handling so an in-flight candle never skews the value.
 */
const computeAtr = (
  market: MarketSnapshot,
  interval: TTConfig['candleInterval'],
  period: number,
): Decimal | null => {
  const candles = (market.candlesByInterval[interval] ?? []).filter((c) => c.isClosed);
  if (candles.length < period + 1) return null;
  try {
    return atr(candles, period);
  } catch {
    return null;
  }
};

/**
 * Close of the most-recently-closed candle on the trading interval, or null when
 * no closed candle is present (cold start). This is the reference price the
 * high-water mark ratchets on, deliberately NOT `market.currentPrice`: post
 * live-price reaction, `currentPrice` is the sub-second mini-ticker print, so a
 * transient intra-candle up-wick would permanently inflate `highSinceBuy` and
 * leave the trailing stop sitting too high, clipping a winner on the next normal
 * pullback. Ratcheting on the closed-candle close makes the high-water mark
 * immune to live wicks while the fire-cross still reacts to the live price.
 */
const latestClosedClose = (
  market: MarketSnapshot,
  interval: TTConfig['candleInterval'],
): Decimal | null => {
  const last = (market.candlesByInterval[interval] ?? [])
    .filter((c) => c.isClosed)
    .reduce<Candle | null>(
      (best, c) => (best === null || c.closeTimeMs > best.closeTimeMs ? c : best),
      null,
    );
  return last === null ? null : safeDecimal(last.close);
};

/**
 * Count of CLOSED candles of `interval` whose close is strictly after
 * `sinceMs`. The shared bar count the time-stops and the maker entry timeout
 * use. The candle in progress at `sinceMs` is counted once it closes, matching
 * the operator-facing "this many closed candles". `sinceMs` is the entry instant
 * for a time-stop, the order placement time for the entry timeout.
 */
export const closedBarsSinceEntry = (
  market: MarketSnapshot,
  interval: TTConfig['candleInterval'],
  sinceMs: number,
): number =>
  (market.candlesByInterval[interval] ?? []).filter((c) => c.isClosed && c.closeTimeMs > sinceMs)
    .length;

/**
 * Why an emitted sell fired. Closed, and named rather than inlined at the one
 * signature that takes it, because {@link sellEmissionOrSkip} derives the exit's
 * metric name from the member string at runtime: this union IS the set of
 * `tt_*_emit` series the exit path can ever produce, so anything asserting over
 * that series set has to be able to name it.
 */
export type SellEmissionReason =
  | 'grid-sell'
  | 'grid-stop-loss'
  | 'technicals-force-sell'
  | 'regime-exit'
  | 'discovery-time-stop'
  | 'break-even-stop'
  | 'time-stop';

export interface SellGateEmit {
  readonly kind: 'emit';
  readonly decision: ReturnType<typeof buildSellDecision>;
  readonly log: LogEntry;
  readonly metricName: string;
}
export interface SellGateBumpHigh {
  readonly kind: 'bump-high';
  readonly state: TTState;
  /** Why no exit fired this tick. Null only until {@link evaluateSellGate} resolves it. */
  readonly blocker: ExitBlocker | null;
}
export interface SellGateSkip {
  readonly kind: 'skip';
  readonly log: LogEntry;
  /** Sizing rejection that turned a firing rung into a skip, else null (a parse failure). */
  readonly skipReason: SellSkipReason | null;
  /**
   * Config field whose stored value would not parse, absent on every other skip.
   * Carried out so the blocker can name the dead rung: without it the corrupt
   * field sets no candidate and the resolver falls through to
   * `no-exit-configured`, which contradicts the `hasDownsideExit: true` it
   * reports on the same record.
   */
  readonly configInvalidField?: string;
  readonly blocker: ExitBlocker | null;
}
export interface SellGateNoop {
  readonly kind: 'noop';
  readonly blocker: ExitBlocker | null;
}
export type SellGateResult = SellGateEmit | SellGateBumpHigh | SellGateSkip | SellGateNoop;

/**
 * What {@link sellEmissionOrSkip} can return. It declines only for a SIZING
 * reason, so its skip always names one, and a caller reading that reason needs
 * no guard for a case that cannot occur.
 */
export type SellEmissionResult =
  SellGateEmit | (SellGateSkip & { readonly skipReason: SellSkipReason });

/**
 * Parse a Decimal config field, or return the standard parse-failed skip whose
 * `{ field, value, err }` log context the sell gate emits identically for each
 * such field. Collapses the otherwise-repeated parse-and-skip block for
 * stopLoss / trigger / trailing (the `{ field, value, err }` shape only; the
 * lbp/price and no-`err` skips keep their bespoke contexts).
 */
const parseFieldOrSkip = (
  value: string,
  field: string,
):
  | { readonly ok: true; readonly value: Decimal }
  | { readonly ok: false; readonly skip: SellGateSkip } => {
  const parsed = parseDecimal(value);
  if (parsed.ok) return { ok: true, value: parsed.value };
  return {
    ok: false,
    skip: {
      kind: 'skip',
      skipReason: null,
      configInvalidField: field,
      blocker: null,
      log: log('warn', 'tt-sell-gate-parse-failed', { field, value, err: parsed.err }),
    },
  };
};

/**
 * Evaluate the three sell-side gates in priority order: stop-loss
 * (loss-first), trigger-arm (start trailing), trailing-stop (retrace
 * from high). Returns a discriminated union describing what the
 * caller should do.
 *
 * Stop-loss MUST fire before trailing-stop is evaluated so a single
 * sharp drop that crosses both thresholds emits exactly one SELL with
 * `reason='grid-stop-loss'` (the loss-realised audit signal) rather
 * than a `grid-sell` that hides the stop-loss event.
 *
 * The trigger and the trailing-stop both update / read `highSinceBuy`
 * on `nextState`; the caller takes a new state with the bumped high.
 */
const runSellLadder = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  state: TTState,
  cand: ExitCandidates,
): SellGateResult => {
  // Preconditions enforced upstream:
  //   - config.sell.enabled
  //   - state.avgEntryPrice !== null
  //   - no open SELL for the symbol
  // The early returns below treat parse failures as `noop` rather than
  // crashing the tick, with a typed log so the worker logger surfaces
  // the misconfiguration to operators.
  const lbpStr = state.avgEntryPrice;
  if (lbpStr === null) return { kind: 'noop', blocker: null };
  const priceStr = input.market.currentPrice;
  const stopLossStr = input.config.sell.stopLossPercentage;
  const triggerStr = input.config.sell.triggerPercentage;
  const trailingStr = input.config.sell.trailingStopPercentage;
  // Is there a trailing exit to arm at all? Read off the config (not the live
  // regime verdict) so the answer is stable tick to tick: with no trail
  // configured, reaching the sell arm sets a high-water mark that nothing
  // consumes, and naming that arm as the gate would promise an exit that does
  // not exist.
  const trailConfigured =
    (typeof trailingStr === 'string' && trailingStr !== '' && trailingStr !== '0') ||
    input.config.sell.atrTrailing?.enabled === true ||
    input.config.regime?.onBull?.hold?.enabled === true;
  const lbpParse = parseDecimal(lbpStr);
  if (!lbpParse.ok) {
    return {
      kind: 'skip',
      skipReason: null,
      blocker: null,
      log: log('warn', 'tt-sell-gate-parse-failed', {
        err: lbpParse.err,
        avgEntryPrice: lbpStr,
        currentPrice: priceStr,
      }),
    };
  }
  const priceParse = parseDecimal(priceStr);
  if (!priceParse.ok) {
    return {
      kind: 'skip',
      skipReason: null,
      blocker: null,
      log: log('warn', 'tt-sell-gate-parse-failed', {
        err: priceParse.err,
        avgEntryPrice: lbpStr,
        currentPrice: priceStr,
      }),
    };
  }
  const lbp = lbpParse.value;
  const price = priceParse.value;
  if (lbp.lte(0) || price.lte(0)) return { kind: 'noop', blocker: null };

  // High-water ratchet reference: the closed-candle close, not the (possibly
  // live) `currentPrice`, so an intra-candle wick can't inflate `highSinceBuy`.
  // Falls back to the live price only at cold start (no closed candle yet).
  const closedRef = latestClosedClose(input.market, input.config.candleInterval);
  const ratchetPrice = closedRef ?? price;

  // Stop-loss: price <= lbp * stopLossPercentage. Configured value
  // is disabled when empty or '0'. Parse failure surfaces as a warn
  // so a corrupted config doesn't silently disable the safety net.
  if (stopLossStr !== '' && stopLossStr !== '0') {
    const stopLossParse = parseFieldOrSkip(stopLossStr, 'stopLossPercentage');
    if (!stopLossParse.ok) return stopLossParse.skip;
    const stopLoss = stopLossParse.value;
    if (stopLoss.gt(0) && stopLoss.lte(1)) {
      const { stop: stopPrice } = resolveTTStopLevel({
        avgEntry: lbp,
        stopPct: stopLoss,
        protectiveStop: input.config.sell.protectiveStop,
        bandContext: {
          reference: input.market.currentPrice,
          band: input.market.symbolInfo.filters.percentPriceBySide,
        },
      });
      if (price.lte(stopPrice)) {
        return sellEmissionOrSkip(
          input,
          state,
          'grid-stop-loss',
          'tt-stop-loss',
          `stop-${state.avgEntryPrice}`,
        );
      }
      cand.stopLoss = { stopPrice };
    } else {
      // Parsed fine, then failed the schema's runtime re-check. Without a
      // candidate here the ladder falls through to `no-exit-configured` while
      // `hasDownsideExit` still reports this stop-loss as configured, which
      // tells the operator nothing is set up and nothing is wrong at once.
      cand.configInvalid = { field: 'stopLossPercentage' };
    }
  }

  // Break-even stop (opt-in): after the hard stop-loss (loss-first) and before
  // the profit-trail arming. Arms a sticky flag once a CLOSED candle confirms a
  // gain of `breakEven.armAtPercentage` — arming on the closed close (not a live
  // wick) so a transient spike can't arm it. While armed AND before the profit
  // trail owns the position (`highSinceBuy === null`), a LIVE retrace to
  // `breakEven.floorPercentage` (1 = entry) market-sells near break-even: the
  // fix for a move that popped but stalled before reaching `triggerPercentage`,
  // which would otherwise ride the hard stop down. Once the trail arms
  // (`highSinceBuy !== null`) it supersedes this floor (it trails a higher
  // high). Off (default) ⇒ skipped, leaving the arm/trail paths byte-identical
  // (golden-replay diff = 0).
  // Optional chaining: the live worker passes RAW stored config (no schema
  // parse), so a profile saved before this field existed has no `breakEven`
  // block — treat a missing block as disabled rather than crashing the tick.
  const breakEven = input.config.sell.breakEven;
  if (breakEven?.enabled === true) {
    const floorParse = parseFieldOrSkip(breakEven.floorPercentage, 'breakEven.floorPercentage');
    if (!floorParse.ok) return floorParse.skip;
    const floor = floorParse.value;
    // `floor.gte(1)` re-enforces the schema's never-below-entry bound at runtime
    // (the worker ticks RAW config), and is hoisted so the arming tick below can
    // name the floor it just installed without recomputing the level.
    const floorPrice = floor.gte(1) ? lbp.times(floor) : null;
    // Same reasoning as the stop-loss bound above: a sub-entry floor is
    // rejected, so record WHY rather than leaving the rung silently absent.
    if (floorPrice === null) cand.configInvalid = { field: 'breakEven.floorPercentage' };
    if (state.breakEvenArmed === true) {
      // Armed: exit on a live retrace to the floor, but only while the profit
      // trail has not taken over. Above the floor (or trail armed) ⇒ fall
      // through to the trail paths below. A corrupted sub-1 floor must not
      // market-sell at a LOSS under the break-even label — cutting a loss is the
      // hard stop-loss's job. Mirrors the stopLoss / trailing guards, which
      // likewise re-check their bounds here.
      if (state.highSinceBuy === null && floorPrice !== null) {
        if (price.lte(floorPrice)) {
          return sellEmissionOrSkip(
            input,
            state,
            'break-even-stop',
            'tt-break-even-stop',
            `break-even-${state.avgEntryPrice}`,
          );
        }
        cand.breakEvenFloor = { floorPrice };
      }
    } else {
      const armParse = parseFieldOrSkip(breakEven.armAtPercentage, 'breakEven.armAtPercentage');
      if (!armParse.ok) return armParse.skip;
      const armAt = armParse.value;
      const beArmPrice = armAt.gt(1) ? lbp.times(armAt) : null;
      if (beArmPrice === null) cand.configInvalid = { field: 'breakEven.armAtPercentage' };
      if (beArmPrice !== null && !ratchetPrice.gte(beArmPrice)) {
        cand.breakEvenArm = { armPrice: beArmPrice };
      }
      if (beArmPrice !== null && ratchetPrice.gte(beArmPrice)) {
        // Arm the sticky flag via the bump-high carrier (persist new state, no
        // sell); the caller continues and the regime exit still evaluates.
        // The floor becomes the live protective rung from this tick on, so name
        // it rather than the lower rung the ladder happened to record first.
        if (floorPrice !== null) cand.breakEvenFloor = { floorPrice };
        return { kind: 'bump-high', blocker: null, state: { ...state, breakEvenArmed: true } };
      }
    }
  }

  // fromEntry arm: when ATR trailing is enabled with `fromEntry`, arm
  // highSinceBuy from the entry price on the first held tick, independent of
  // triggerPercentage. This makes the ATR branch below (gated on highSinceBuy
  // != null) live from entry, so a trend-follower trails out of a position that
  // dips before reaching the sell trigger instead of relying on the hard stop
  // alone. Seeded from the entry (cost basis), not from a below-entry price, so
  // the trail measures drawdown from the entry. Placed AFTER the stop-loss
  // branch (a hard loss still wins on the entry tick) and BEFORE the trigger-arm
  // block, which it supersedes when active — the trigger-arm is then redundant
  // (the trail is already armed), so this is the sole bump-high path and there
  // is no double-bump. On a non-new-high tick it falls through so the ATR branch
  // can evaluate the trail and fire. Off (default) ⇒ skipped entirely, leaving
  // the trigger-arm path byte-identical (golden-replay diff = 0).
  const atrTrailing = input.config.sell.atrTrailing;
  if (atrTrailing.enabled && atrTrailing.fromEntry) {
    const prevHigh = state.highSinceBuy === null ? lbp : safeDecimal(state.highSinceBuy);
    if (prevHigh !== null) {
      // Ratchet on the closed-candle close so a live wick can't bump the high.
      if (state.highSinceBuy === null || ratchetPrice.gt(prevHigh)) {
        const newHigh = Decimal.max(prevHigh, ratchetPrice);
        cand.trailHighRaised = { high: newHigh };
        return {
          kind: 'bump-high',
          blocker: null,
          state: { ...state, highSinceBuy: newHigh.toString() },
        };
      }
      // Already armed and not a new high: fall through so the ATR branch below
      // can evaluate the trail and fire.
    }
  }

  // Trigger arm: price >= lbp * triggerPercentage. Sets / bumps
  // highSinceBuy. Parse failure surfaces as warn. Skipped when the fromEntry arm
  // is active (it already owns highSinceBuy) so there is exactly one bump-high
  // path and the two never conflict.
  if (!(atrTrailing.enabled && atrTrailing.fromEntry) && triggerStr !== '' && triggerStr !== '0') {
    const triggerParse = parseFieldOrSkip(triggerStr, 'triggerPercentage');
    if (!triggerParse.ok) return triggerParse.skip;
    const trigger = triggerParse.value;
    // Don't arm the profit trail until price clears the round-trip fee, so a
    // trail that fires right after arming can't book a net loss. The raw
    // `trigger > 1` guard still decides whether trailing is enabled at all; only
    // the price level is lifted to the fee floor. With fees unset the floor is
    // `1 + 0 = 1` and `trigger` is always > 1 here, so `max(trigger, 1) = trigger`
    // and the arm is byte-identical (golden-replay diff = 0).
    const effTrigger = Decimal.max(
      trigger,
      new Decimal(1).plus(roundTripFeeFraction(input.config)),
    );
    // The arm condition stays on the live price so a fast spike arms the trail
    // immediately; only the high-water VALUE ratchets on the closed-candle close.
    const armPrice = lbp.times(effTrigger);
    if (trigger.gt(1) && state.highSinceBuy === null && price.lt(armPrice) && trailConfigured) {
      // The trail is the exit this position is waiting on and it does not exist
      // yet: `highSinceBuy` is what every trailing branch below is gated on, and
      // only this arm sets it. Recorded with the arm price so the operator reads
      // one number instead of inferring it from a percentage.
      cand.awaitingArm = { armPrice };
    }
    if (trigger.gt(1) && price.gte(armPrice)) {
      // Trigger threshold met: bump high-water mark if the closed-candle close
      // is a new high (or set the initial high).
      const prevHigh = state.highSinceBuy === null ? null : safeDecimal(state.highSinceBuy);
      if (prevHigh === null || ratchetPrice.gt(prevHigh)) {
        cand.trailHighRaised = { high: ratchetPrice };
        return {
          kind: 'bump-high',
          blocker: null,
          state: { ...state, highSinceBuy: ratchetPrice.toString() },
        };
      }
    }
  }

  // ATR trailing: stop = high − multiplier × ATR(period) on the trading interval.
  // Two opt-in paths share this branch:
  //   - `sell.atrTrailing.enabled` — the operator's regime-independent ATR trail.
  //   - `regime.onBull.hold` — widen the trail (room-mapped multiplier) ONLY while
  //     a confirmed daily bull holds, so routine pullbacks do not scalp a winning
  //     trend. `highSinceBuy` is untouched, so when the bull ends next tick the
  //     trail snaps back to its normal distance automatically (auto-tighten).
  // The branch is entered only when at least one path is active, so a default-off
  // profile (atr off AND not a held bull) never reaches here and the fixed-% path
  // below stays byte-identical (golden-replay diff = 0). When entered and the ATR
  // is computable this branch OWNS the trail — fires the sell or returns noop,
  // never double-evaluating the same retrace on the fixed-% path. It falls through
  // only when ATR is not yet computable (cold / short window) or degenerate, so a
  // fresh or bull-held position still trails on the fixed-% rule meanwhile.
  const atrCfg = atrTrailing;
  const bullMult = bullHoldMultiplier(input.config, input.market);
  if (state.highSinceBuy !== null && (atrCfg.enabled || bullMult !== null)) {
    const high = safeDecimal(state.highSinceBuy);
    const atrValue = computeAtr(input.market, input.config.candleInterval, atrCfg.period);
    if (high !== null && atrValue !== null) {
      const mult = selectTrailMultiplier(atrCfg, bullMult);
      if (mult === null) {
        cand.configInvalid = { field: 'atrTrailing.multiplier' };
        return {
          kind: 'skip',
          skipReason: null,
          blocker: null,
          log: log('warn', 'tt-sell-gate-parse-failed', {
            field: 'atrTrailing.multiplier',
            value: atrCfg.multiplier,
          }),
        };
      }
      const stopLevel = high.minus(mult.times(atrValue));
      // A non-positive stop is degenerate: multiplier × ATR exceeds the whole
      // high, so the ATR trail is wider than the entire price and could never
      // fire. Fall through to the fixed-% trail rather than returning noop, so a
      // position is never silently left with no trailing protection. For a
      // positive stop the ATR branch owns the trail (fire or noop).
      if (stopLevel.gt(0)) {
        if (!price.lte(stopLevel)) cand.armedTrail = { source: 'atr', trailPrice: stopLevel, high };
        if (price.lte(stopLevel)) {
          return sellEmissionOrSkip(
            input,
            state,
            'grid-sell',
            'tt-atr-trailing-stop',
            `atr-trail-${state.highSinceBuy}`,
            // Surface the bull-held widening so an operator can tell a
            // bull-room trail from a plain ATR trail in the sell log.
            bullMult !== null ? { trail: 'atr-bull', atrMultiplier: mult.toFixed() } : undefined,
          );
        }
        return { kind: 'noop', blocker: null };
      }
    }
    // high parse failure, ATR unavailable, or a degenerate non-positive ATR
    // stop: fall through to the fixed-% trail.
  }

  // Trailing-stop: highSinceBuy != null AND price <= high * trailingStopPercentage.
  // `trailingStr` may be `undefined` for older profile rows recorded
  // before `trailingStopPercentage` joined the config schema; treat the
  // undefined / empty / '0' cases identically as "disabled" so an
  // older profile doesn't trip the Decimal-parse warn path.
  if (
    state.highSinceBuy !== null &&
    typeof trailingStr === 'string' &&
    trailingStr !== '' &&
    trailingStr !== '0'
  ) {
    const high = safeDecimal(state.highSinceBuy);
    if (high === null) {
      cand.configInvalid = { field: 'highSinceBuy' };
      return {
        kind: 'skip',
        skipReason: null,
        blocker: null,
        log: log('warn', 'tt-sell-gate-parse-failed', {
          field: 'highSinceBuy',
          value: state.highSinceBuy,
        }),
      };
    }
    const trailingParse = parseFieldOrSkip(trailingStr, 'trailingStopPercentage');
    if (!trailingParse.ok) return trailingParse.skip;
    const trailing = trailingParse.value;
    if (trailing.gt(0) && trailing.lte(1)) {
      const trailPrice = high.times(trailing);
      if (price.lte(trailPrice)) {
        return sellEmissionOrSkip(
          input,
          state,
          'grid-sell',
          'tt-trailing-stop',
          `trail-${state.highSinceBuy}`,
        );
      }
      cand.armedTrail = { source: 'fixed', trailPrice, high };
    }
  }

  // Discovery time-stop (last, so stop-loss and the profit trail keep their
  // precedence). A discovery single-entry that has neither taken profit nor hit
  // its stop after `discoveryTimeStopBars` CLOSED candles of the trading interval
  // has a stale thesis — market-sell it to free the capital. Counts candle
  // CLOSES strictly after the entry instant (the candle in progress at entry is
  // counted once it closes), i.e. N candle-closes after entry — matching the
  // operator-facing "this many closed candles". Off (inert) unless this is a
  // discovery entry with a timestamp and a positive bar count.
  if (
    state.discoveryEntry === true &&
    state.entryAtMs !== null &&
    input.config.sell.discoveryTimeStopBars > 0
  ) {
    const closed = closedBarsSinceEntry(input.market, input.config.candleInterval, state.entryAtMs);
    if (closed >= input.config.sell.discoveryTimeStopBars) {
      return sellEmissionOrSkip(
        input,
        state,
        'discovery-time-stop',
        'tt-discovery-time-stop',
        `time-stop-${state.entryAtMs}`,
      );
    }
    cand.timeStop = { closedBars: closed, requiredBars: input.config.sell.discoveryTimeStopBars };
  }

  // General time-stop (opt-in): cut a NON-discovery position that "went nowhere".
  // Fires only while the profit trail has NOT armed (`highSinceBuy === null`) — a
  // position that reached the sell trigger is being managed by the trail, not
  // stalled — after `timeStopBars` closed candles since entry. entryAtMs is
  // stamped on a non-discovery first entry only when this is enabled (grid-buy.ts),
  // so off (default 0) it never fires and the gate stays byte-identical. The
  // discovery branch above owns discovery entries; this owns the rest.
  // A raw pre-feature config has no timeStopBars; `undefined > 0` is false, so
  // the gate stays inert without a nullish guard (matching how grid-buy reads it).
  const timeStopBars = input.config.sell.timeStopBars;
  if (
    state.discoveryEntry !== true &&
    state.highSinceBuy === null &&
    state.entryAtMs !== null &&
    timeStopBars > 0
  ) {
    const closed = closedBarsSinceEntry(input.market, input.config.candleInterval, state.entryAtMs);
    if (closed >= timeStopBars) {
      return sellEmissionOrSkip(
        input,
        state,
        'time-stop',
        'tt-time-stop',
        `time-stop-${state.entryAtMs}`,
      );
    }
    cand.timeStop = { closedBars: closed, requiredBars: timeStopBars };
  }

  return { kind: 'noop', blocker: null };
};

/**
 * Evaluate the sell ladder and, when nothing fired, say WHY: the rung the
 * position stopped at plus the threshold that rung compared against. The blocker
 * is assembled from the ladder's own locals rather than recomputed, so the
 * recorded threshold is by construction the one the worker traded on.
 *
 * `emit` carries no blocker — the position is closing, so nothing is blocked.
 */
export const evaluateSellGate = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  state: TTState,
): SellGateResult => {
  const cand = noExitCandidates();
  const result = runSellLadder(input, state, cand);
  if (result.kind === 'emit') return result;
  if (result.kind === 'skip' && result.skipReason !== null) {
    cand.unsellable = { skip: result.skipReason };
  }
  if (result.kind === 'skip' && result.configInvalidField !== undefined) {
    cand.configInvalid = { field: result.configInvalidField };
  }
  return {
    ...result,
    blocker: resolveExitBlocker({
      ...cand,
      // The caller only runs the ladder on an enabled sell side with no open
      // SELL; it owns those two reasons itself.
      sellDisabled: false,
      openSellOrder: false,
      currentPrice: safeDecimal(input.market.currentPrice),
      hasDownsideExit: hasDownsideExitConfigured(input.config, state.discoveryEntry === true),
    }),
  };
};

/**
 * Sell-trigger price the force-sell-on-Technicals evaluator uses to gate
 * its "below trigger" guard. Mirrors `evaluateSellGate`'s arm logic:
 * `avgEntryPrice * sell.triggerPercentage`. Returns `{ price: '0',
 * parseFail: true }` on a corrupted config value so the caller can emit a
 * warn log — silently returning '0' would mask the misconfiguration on the
 * force-sell path while `evaluateSellGate` already emits a warn on the same
 * parse failure.
 */
export const technicalsForceSellTriggerPriceOf = (
  config: TTConfig,
  state: TTState,
): { readonly price: string; readonly parseFail: boolean } => {
  const lbp = state.avgEntryPrice;
  const triggerStr = config.sell.triggerPercentage;
  if (lbp === null || triggerStr === '' || triggerStr === '0') {
    return { price: '0', parseFail: false };
  }
  const lbpDec = safeDecimal(lbp);
  const tDec = safeDecimal(triggerStr);
  if (lbpDec === null || tDec === null) return { price: '0', parseFail: true };
  if (!tDec.gt(0)) return { price: '0', parseFail: false };
  return { price: lbpDec.times(tDec).toFixed(), parseFail: false };
};

/**
 * Resolve the held base-asset quantity for a sell-sizing decision.
 *
 * `state.heldQuantity` is the authoritative per-profile-symbol source —
 * maintained by the fill-adopter and reconciled against the wallet at
 * boot. The wallet's `free` balance is held only as a safety cap so a
 * stale state row can never request a sell larger than what Binance
 * will accept (wallet.free is the sellable surface; `locked` is committed
 * to open SELL orders and is not sellable, except the portion the bot's own
 * resting protective stop holds — see `reclaimable` below).
 *
 * Fallback to wallet.free when `heldQuantity` is null is the
 * pre-fill-adopter compatibility path: a legacy 1.0.0 → 1.1.0 migrated
 * row starts with `null` and continues to size by wallet until the next
 * BUY fill or boot reconciler populates it.
 *
 * `reclaimable` adds back base the bot's OWN resting SELL orders lock — a
 * resting STOP_LOSS_LIMIT locks the base on Binance, dropping wallet `free`
 * to zero. That balance is reclaimable: the protective-stop re-arm replaces
 * its own order, and a closing batch cancels it before the market sell. Without
 * adding it back the cap reads zero free and the stop cancels itself every tick
 * (a place/cancel churn) while in-process exits can't size. Defaults to zero,
 * so a symbol with no own resting SELL is byte-identical to the prior behaviour.
 * `sizableBase` drops the credit when the wallet shows no line for the base at
 * all — the resting order we still "see" is then a stale cache entry for a stop
 * that has already filled.
 *
 * An UNREADABLE wallet (empty balance map) is NOT zero free. Capping on it would
 * collapse every sell to `no-balance`, so a stop-loss or regime exit would be
 * suppressed precisely because the bot could not read the wallet. Fail OPEN on
 * the tracked position instead — but invent nothing: a `null` heldQuantity has no
 * tracked position to fall back on, and the resting-order view is not one.
 */
export const resolveHeldForSell = (
  state: TTState,
  baseAsset: string,
  account: TickInput<TTConfig, TTState, TTBundle>['account'],
  reclaimable: Decimal = new Decimal(0),
): string => {
  const wallet = sizableBase(account, baseAsset, reclaimable);
  // Null, malformed, or non-positive all mean the same thing: no tracked position
  // to cap against, and none to fall back on.
  const parsed = state.heldQuantity === null ? null : safeDecimal(state.heldQuantity);
  const tracked = parsed !== null && parsed.gt(0) ? parsed : null;

  if (wallet.free === undefined) return tracked === null ? '0' : tracked.toFixed();

  const free = wallet.free.add(wallet.reclaimable);
  return tracked === null ? free.toFixed() : Decimal.min(tracked, free).toFixed();
};

/**
 * Base-asset quantity the bot's OWN resting protective stop locks, which a
 * sell can reclaim (see {@link resolveHeldForSell}). Matched by the
 * deterministic protective-stop clientOrderId, SELL side, and a live status —
 * the same predicate {@link findRestingProtectiveStop} uses — so an unrelated
 * resting SELL (an operator's manual order) is never reclaimed. Zero when no
 * own protective stop rests, keeping the default sizing path unchanged.
 */
export const reclaimableOwnSellBase = (input: TickInput<TTConfig, TTState, TTBundle>): Decimal =>
  ownRestingSellBase(
    input.openOrders,
    protectiveStopClientOrderId(input.profile.id, input.market.symbol),
    input.market.symbol,
  );

export const sellEmissionOrSkip = (
  input: TickInput<TTConfig, TTState, TTBundle>,
  state: TTState,
  reason: SellEmissionReason,
  messagePrefix: string,
  clientOrderIdSeed: string,
  // Extra emit-log context. Omitted (undefined) on every existing call so the
  // default-path log object stays byte-identical (golden-replay diff = 0); only
  // the bull-hold trail passes it.
  extraLog?: Readonly<Record<string, unknown>>,
): SellEmissionResult => {
  const baseAsset = input.market.symbolInfo.baseAsset;
  // A closing batch cancels the bot's own resting protective stop before the
  // market sell, so the base that stop locks is reclaimable for sizing here —
  // otherwise a held position with a resting stop reads zero free and the exit
  // can never size.
  const free = resolveHeldForSell(state, baseAsset, input.account, reclaimableOwnSellBase(input));
  // The one boundary that knows the sell was sized off the tracked position
  // rather than off the wallet. Stamped only on the UNKNOWN branch so a normal
  // tick's log object is unchanged, and so an operator reading back a surprising
  // quantity can see WHY it was not capped.
  const trace =
    freeBalance(input.account, baseAsset) === undefined ? { walletUnreadable: true } : {};
  const result = computeSellQuantity(
    free,
    input.market.currentPrice,
    input.market.symbolInfo.filters,
  );
  if ('quantity' in result) {
    return {
      kind: 'emit',
      decision: buildSellDecision(input, reason, result.quantity, clientOrderIdSeed),
      log: log('info', messagePrefix, {
        symbol: input.market.symbol,
        quantity: result.quantity,
        freeBase: free,
        currentPrice: input.market.currentPrice,
        ...trace,
        ...(extraLog ?? {}),
      }),
      metricName: `tt_${reason.replaceAll('-', '_')}_emit`,
    };
  }
  const skipReason = (result as { skip: SellSkipReason }).skip;
  // The WARN channel is the operator-alert level. Every idle tick on a
  // no-position profile takes the `no-balance` branch, so emitting WARN here
  // drowns real alerts. Reserve WARN for genuinely-actionable skips:
  // `invalid-filters` means exchange-info is malformed. Dust states
  // (`min-qty`, `min-notional`) are informational — operator may want to know
  // but no action required. See #265.
  return {
    kind: 'skip',
    skipReason,
    blocker: null,
    log: log(sellSkipLogLevel(skipReason), `${messagePrefix}-skipped`, {
      symbol: input.market.symbol,
      reason: skipReason,
      freeBase: free,
      ...trace,
    }),
  };
};

export const sellSkipLogLevel = (reason: SellSkipReason): 'debug' | 'info' | 'warn' => {
  switch (reason) {
    case 'no-balance':
      return 'debug';
    case 'min-qty':
    case 'min-notional':
      return 'info';
    case 'invalid-filters':
      return 'warn';
  }
};
