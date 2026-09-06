import { Decimal, roundToTick } from '@app/money';
import {
  evaluateProtectiveStopArm as coreEvaluateProtectiveStopArm,
  findRestingProtectiveStop as coreFindRestingProtectiveStop,
  clampedStopDrift,
  decOrNull,
  nativeTrailingDelta,
  ownRestingSellBase,
  parseFilters,
} from '@app/strategy-core';
import type {
  Decision,
  DesiredNativeTrailingStop,
  DesiredProtectiveStop,
  OpenOrder,
  ProtectiveStopArm,
  ProtectiveStopBandSettings,
  ProtectiveStopLevel,
  TickInput,
} from '@app/strategy-core';

import { protectiveStopClientOrderId } from './client-order-id.js';
import { profitLegDistance } from './profit-leg.js';
import type { MomentumBundle, MomentumConfig, MomentumState } from './schema.js';
import type { StopResolution } from './stop-level.js';

type MomentumInput = TickInput<MomentumConfig, MomentumState, MomentumBundle>;

// Default limit offset when a stored config predates the field: 2% below the
// trigger so a tripped STOP_LOSS_LIMIT crosses the book. Exported because the
// stop resolver needs the same fallback to derive the exchange price floor, and
// two copies of it would floor at two different prices.
export const DEFAULT_LIMIT_OFFSET = '0.98';

// `new Decimal` throws on malformed input; a protective-stop input that fails to
// parse must skip (no arm), never crash the tick.
const safeDecimal = (value: string): Decimal | null => {
  try {
    return new Decimal(value);
  } catch {
    return null;
  }
};

/**
 * The resting exchange-side protective stop for this (profile, symbol), keyed on
 * momentum's `-ps` clientOrderId scheme. Thin binding of that scheme to the
 * shared finder — the `isRestingSell` denylist and identity match live in
 * `@app/strategy-core`, single-sourced with the trailing-trade strategy.
 */
export const findRestingProtectiveStop = (
  openOrders: readonly OpenOrder[],
  profileId: string,
  symbol: string,
): OpenOrder | undefined =>
  coreFindRestingProtectiveStop(openOrders, protectiveStopClientOrderId(profileId, symbol));

// A foreign resting SELL (an operator's own order, or a ghost left by a deleted
// profile) locks base we cannot release. Shared with the trailing-trade strategy
// so both answer "what can I actually arm?" with the same money math.
export { findForeignRestingSell } from '@app/strategy-core';

// The shared arm's blocker shape is exactly this strategy's persisted
// `protectiveStopBlocker` field, so tick() assigns it straight into nextState.
export type { ProtectiveStopArm } from '@app/strategy-core';

/**
 * The shared arm's outcome plus native-mode binding facts. A band substitution leaves no blocker, while an unavailable primary trail falls back to pricing; the tick needs both facts to report the exchange protection honestly.
 */
export interface MomentumProtectiveStopArm extends ProtectiveStopArm {
  readonly nativeTrailed: boolean;
  readonly nativeUnavailable: boolean;
}

/**
 * Round the caller's resolved trail level onto the symbol's tick grid and derive
 * the limit price, or null when there is nothing to protect (flat, no tracked
 * quantity) or an input does not parse.
 *
 * The level itself is NOT recomputed here. It arrives from the same
 * `resolveStopLevel` call the in-process trail tested, which is what makes the
 * resting order a faithful backstop rather than a second, quietly different stop
 * — a property that used to rest on two copies of a formula staying in step.
 */
const computeProtectiveStopLevel = (
  input: MomentumInput,
  state: MomentumState,
  rawStop: Decimal,
): ProtectiveStopLevel | null => {
  if (state.entryPrice === null) return null;
  const held = state.heldQuantity === null ? null : safeDecimal(state.heldQuantity);
  if (held === null || held.lte(0)) return null;

  const tick = safeDecimal(input.market.symbolInfo.filters.tickSize);
  const filters = parseFilters(input.market.symbolInfo.filters);
  if (tick === null || tick.lte(0) || filters === null) return null;

  const offset = safeDecimal(
    input.config.protectiveStop?.limitOffsetPercentage ?? DEFAULT_LIMIT_OFFSET,
  );
  if (offset === null || offset.lte(0) || offset.gte(1)) return null;

  const stop = roundToTick(rawStop, tick);
  // roundToTick floors, and offset is strictly in (0, 1), so limit < stop
  // always (or rounds to 0, caught below) — the limit sits below the trigger so
  // a tripped STOP_LOSS_LIMIT crosses a falling book.
  const limit = roundToTick(stop.mul(offset), tick);
  if (stop.lte(0) || limit.lte(0)) return null;
  return { stop, limit, held, filters, tick };
};

const placeDecision = (
  input: MomentumInput,
  desired: DesiredProtectiveStop,
  rearm: boolean,
): Decision => ({
  type: 'place-order',
  intent: {
    symbol: input.market.symbol,
    side: 'SELL',
    reason: 'protective-stop',
    clientOrderId: protectiveStopClientOrderId(input.profile.id, input.market.symbol),
    // A re-price only: the stop it replaces keeps resting until the paired cancel
    // lands, so the executor may skip the pair when the account's order budget is
    // exhausted and try again next tick. The first arm carries no such fallback
    // and must never be skipped. Omitted rather than `false` so a first arm
    // serialises exactly as it did before the flag existed.
    ...(rearm ? { deferrable: true } : {}),
  },
  params: {
    type: 'STOP_LOSS_LIMIT',
    stopPrice: desired.stopPrice,
    price: desired.price,
    quantity: desired.quantity,
    timeInForce: 'GTC',
  },
});

/**
 * Wrap a successor in one atomic exchange replacement that also retires the resting protective order.
 *
 * The successor is not required to be another protective stop. A re-arm at a new level and a position-closing exit SELL are both legitimate, because the `replace-order` contract constrains nothing about the successor's intent — it pairs a cancel with a placement, and the two need only concern the same base.
 *
 * `STOP_ON_FAILURE` is the right pairing for both. The only reason to retire the stop is to free the base the successor needs, so a refused cancel leaves the successor unplaceable anyway, and the still-resting stop keeps protecting the position until the next tick retries. A split cancel and place failed the opposite way: the cancel could fail while the successor went out regardless, leaving the stop and the exit both live against one base.
 *
 * @param resting - The currently resting protective order to cancel atomically.
 * @param place - The exact successor to transmit, from the arm's priced or native place builder or from a closing sell.
 * @returns One replace-order decision carrying the successor intent and params unchanged.
 */
export const replaceDecision = (resting: OpenOrder, place: Decision): Decision => {
  if (place.type !== 'place-order') {
    throw new Error(
      'protective-stop successor builder returned a decision that was not place-order',
    );
  }
  return {
    type: 'replace-order',
    cancelOrderId: resting.orderId,
    reason: 'momentum-protective-stop-superseded',
    intent: place.intent,
    params: place.params,
  };
};

/**
 * The exchange-native trailing form of the same protective stop: a `STOP_LOSS`
 * carrying only a size and a trailing distance. No `stopPrice` and no `price` —
 * both would be banded, and a limit price fixed today cannot fill after the drop
 * it is meant to catch. Binance triggers a MARKET sell instead, which is the cost
 * the operator accepts by choosing this mode.
 *
 * Same clientOrderId as the priced form, so the two occupy one slot: the arm
 * finds, re-arms and cancels either through the same id.
 */
const nativeTrailPlaceDecision = (
  input: MomentumInput,
  desired: DesiredNativeTrailingStop,
  rearm: boolean,
): Decision => ({
  type: 'place-order',
  intent: {
    symbol: input.market.symbol,
    side: 'SELL',
    reason: 'protective-stop',
    clientOrderId: protectiveStopClientOrderId(input.profile.id, input.market.symbol),
    ...(rearm ? { deferrable: true } : {}),
  },
  params: {
    type: 'STOP_LOSS',
    quantity: desired.quantity,
    trailingDelta: desired.trailingDelta,
  },
});

const cancelDecision = (resting: OpenOrder, symbol: string): Decision => ({
  type: 'cancel-order',
  orderId: resting.orderId,
  reason: 'momentum-protective-stop-superseded',
  symbol,
});

/**
 * Fuse a position-closing SELL with the retraction of the resting protective stop into ONE exchange request.
 *
 * A separate cancel followed by a separate place leaves a window in which the retired stop and the exit are both live against the same base, so a gap-down inside that window sells one position twice. The atomic replacement removes the window: the exit is transmitted only once the cancel has succeeded, and a refused cancel leaves the stop resting and still protecting the position until the next tick retries.
 *
 * @param input - The tick input whose open orders are searched for our own resting protective stop.
 * @param sell - The position-closing SELL this batch would emit on its own.
 * @returns One fused replacement when the protective stop is resting, else the sell unchanged (the common case, so a profile that never armed a stop emits the batch it always did).
 */
export const closingSellDecisions = (input: MomentumInput, sell: Decision): Decision[] => {
  const resting = findRestingProtectiveStop(
    input.openOrders,
    input.profile.id,
    input.market.symbol,
  );
  return resting === undefined ? [sell] : [replaceDecision(resting, sell)];
};

/**
 * What this config asks of a symbol's price band, for a caller checking a bind
 * before any position exists.
 *
 * The distance quoted is `trailingStopPct`, the fixed retrace fraction below the
 * high-water mark, and it is the only leg this can quote: it is the one distance
 * derivable from config alone. The ATR leg overrides it whenever
 * `atrTrailingStop` is enabled and the profit trail overrides both once armed,
 * and each of those sits at a distance that moves with live candles. So on a
 * profile using either, this describes the fixed leg rather than the leg in
 * force — a shallower ATR stop is warned about too conservatively, a deeper one
 * not conservatively enough.
 *
 * That is a deliberate trade, not an oversight, because the same fraction also
 * sizes the exchange-native trailing delta. A delta re-derived from the live
 * level would change on every ATR reading, and since the re-arm test compares
 * deltas, each change cancels and re-places the order — which restarts Binance's
 * own high-water mark and destroys the tracking the trail exists for.
 *
 * Null when nothing rests at the exchange, or when the fraction is outside the
 * range the trail itself accepts.
 *
 * Read defensively throughout: the API hands this a parsed config, but the same
 * reader must hold for a stored config saved before `onBandBlock` existed.
 */
export const momentumStopBandSettings = (
  config: MomentumConfig,
): ProtectiveStopBandSettings | null => {
  const ps = config.protectiveStop;
  if (ps?.enabled !== true) return null;
  const stopDistancePct = decOrNull(config.trailingStopPct);
  if (stopDistancePct === null || stopDistancePct.lte(0) || stopDistancePct.gte(1)) return null;
  const limitOffsetPct = decOrNull(ps.limitOffsetPercentage ?? DEFAULT_LIMIT_OFFSET);
  // Upper bound too, matching the arm: an offset at or above 1 prices the limit
  // at or above the trigger and arms nothing, so a warning built from it would
  // describe a stop the exchange is never asked to hold.
  if (limitOffsetPct === null || limitOffsetPct.lte(0) || limitOffsetPct.gte(1)) return null;
  return {
    stopDistancePct,
    limitOffsetPct,
    onBandBlock: ps.onBandBlock ?? 'notify',
    path: ['trailingStopPct'],
  };
};

const ONE_MINUTE_MS = 60_000; // Fixed width of the '1m' candle feed the worker always supplies here.

/**
 * Resolve the stable trailing distance momentum asks Binance to maintain. The profit leg takes priority; the ATR mode uses the already-resolved level; the fixed retrace is the final configured fallback.
 *
 * @param config - The possibly unparsed momentum config for this tick.
 * @param level - The single stop resolution shared by the in-process and exchange arms.
 * @param entry - The open position's cost basis used by profit activation.
 * @returns The desired retrace fraction, or null when no usable distance resolves.
 */
export const desiredTrailDistance = (
  config: MomentumConfig,
  level: StopResolution,
  entry: Decimal,
): Decimal | null => {
  const profitDistance = profitLegDistance(config, level.profitHigh, entry);
  if (profitDistance !== null) return profitDistance;
  if (
    config.atrTrailingStop?.enabled === true &&
    level.stop !== null &&
    level.stop.gt(0) &&
    level.effectiveHigh.gt(0)
  ) {
    return new Decimal(1).minus(level.stop.div(level.effectiveHigh));
  }
  const fixed = decOrNull(config.trailingStopPct);
  return fixed !== null && fixed.gt(0) && fixed.lt(1) ? fixed : null;
};

/**
 * Reconstruct the best high Binance can have observed for one resting native order. Order identity gates persisted state because a replacement starts a fresh exchange high-water mark.
 *
 * @param input - The current tick snapshot containing mark price and 1m candle highs.
 * @param state - Momentum's persisted native-order observation from the prior tick.
 * @param resting - Momentum's currently resting protective order, if any.
 * @returns The native order's reconstructed high, or null when no native order rests.
 */
export const nativeTrailHigh = (
  input: MomentumInput,
  state: MomentumState,
  resting: OpenOrder | undefined,
): Decimal | null => {
  if (resting === undefined || resting.trailingDelta === undefined) return null;
  const mark = new Decimal(input.market.currentPrice);
  return Decimal.max(
    mark,
    ...(state.nativeTrail?.orderId === resting.orderId
      ? [new Decimal(state.nativeTrail.high)]
      : []),
    ...(input.market.candlesByInterval['1m'] ?? [])
      // The placement instant can fall inside an earlier-opening candle; + ONE_MINUTE_MS > includes its post-placement high, while >= would understate Binance's high, and overstatement is safe for a protective stop.
      .filter((candle) => candle.openTimeMs + ONE_MINUTE_MS > resting.transactTimeMs)
      .map((candle) => new Decimal(candle.high)),
  );
};

/**
 * Arm or re-arm the exchange-side protective stop while preserving the position. Momentum supplies its resolved level, reclaimable base, order identity, and decision builders to the shared orchestrator so sizing, foreign-lock refusal, native replacement safety, and re-arm drift stay single-sourced.
 *
 * @param input - The current account, market, open-order, and config snapshot used to size and bind the exchange stop.
 * @param state - The held-position state supplying tracked quantity and native-order high-water continuity.
 * @param level - The single stop resolution already shared with the in-process exit and operator preview.
 * @param entry - The open position's cost basis used to resolve profit activation and the native trailing distance.
 * @returns The exchange decisions, any protective-stop blocker, and native-mode attribution facts for this tick.
 */
export const evaluateProtectiveStopArm = (
  input: MomentumInput,
  state: MomentumState,
  level: StopResolution,
  entry: Decimal,
): MomentumProtectiveStopArm => {
  const symbol = input.market.symbol;
  const ourId = protectiveStopClientOrderId(input.profile.id, symbol);
  // Optional chaining tolerates a stored config that predates the field (the
  // live worker does not schema-parse): undefined ⇒ disabled. The level is
  // computed only when enabled, mirroring the pre-refactor short-circuit.
  const enabled = input.config.protectiveStop?.enabled === true;
  const nativeMode = input.config.protectiveStop?.mode === 'native-trail';
  const distance = nativeMode ? desiredTrailDistance(input.config, level, entry) : null;
  const nativeUnavailable =
    nativeMode &&
    enabled &&
    (distance === null ||
      nativeTrailingDelta({
        stopDistancePct: distance,
        filter: input.market.symbolInfo.filters.trailingDelta,
      }) === null);
  const resting = findRestingProtectiveStop(input.openOrders, input.profile.id, symbol);
  const mark = new Decimal(input.market.currentPrice);
  const restingHigh = nativeTrailHigh(input, state, resting);
  const rawBand = decOrNull(input.config.protectiveStop?.minRearmDriftPct);
  const operatorBand = rawBand !== null && rawBand.gt(0) && rawBand.lt(1) ? rawBand : null;
  // A clamped level tracks the market, so the operator's band (or the shared
  // default) would re-place the order on nearly every tick for as long as the
  // exchange floor is what is holding the stop up.
  const driftBand = level.floorClamped ? clampedStopDrift(operatorBand) : operatorBand;
  // Same optional-chaining discipline: a stored config saved before this leaf
  // existed carries no `onBandBlock` key, which reads as the `notify` default.
  // Routed through the band settings so the trail distance and the operator
  // warning quote ONE derivation of `trailingStopPct`; null here means the
  // fraction is unusable, which is a reason not to offer the escape at all.
  const bandSettings = momentumStopBandSettings(input.config);
  const bandEscapeNative = bandSettings !== null && bandSettings.onBandBlock === 'native-trail';
  const primaryNative = nativeMode && !nativeUnavailable && distance !== null;
  const nativeStopDistance = bandSettings?.stopDistancePct ?? distance;
  // Set from inside the builder rather than inferred from the returned
  // decisions: the shared arm calls it EXACTLY when it substitutes a trail for a
  // band-refused priced stop, which is the fact worth reporting. Reading the
  // decisions back would re-derive that from the order shape and drift the day
  // the trail gains another use.
  let nativeTrailed = false;
  const arm = coreEvaluateProtectiveStopArm({
    input,
    enabled,
    // A null level is "no usable trail this tick", which the shared arm answers
    // by retracting a resting stop rather than leaving a mismatched one.
    level:
      enabled && level.stop !== null ? computeProtectiveStopLevel(input, state, level.stop) : null,
    // Credit back the base our OWN resting stop locks: we cancel it in the same
    // batch that replaces it, so that base is ours to re-commit.
    reclaimableBase: ownRestingSellBase(input.openOrders, ourId, symbol),
    ourClientOrderId: ourId,
    // Operator-settable, because the profit trail can advance the level every few
    // minutes and this band is what decides how much of that reaches Binance as
    // orders. Absent / unparseable falls back to the shared default.
    ...(driftBand === null ? {} : { minStopDrift: driftBand }),
    buildPlace: (desired, rearm) => placeDecision(input, desired, rearm),
    buildReplace: replaceDecision,
    ...(primaryNative
      ? {
          primaryTrail: {
            desiredDistancePct: distance,
            markPrice: mark,
            restingHigh,
          },
        }
      : {}),
    // The builder carries the selected primary trail, or the independently configured band escape when native primary had to fall back to pricing.
    ...((primaryNative || bandEscapeNative) && nativeStopDistance !== null
      ? {
          nativeTrail: {
            stopDistancePct: nativeStopDistance,
            build: (desired: DesiredNativeTrailingStop, rearm: boolean) => {
              if (!primaryNative) nativeTrailed = true;
              return nativeTrailPlaceDecision(input, desired, rearm);
            },
          },
        }
      : {}),
    buildCancel: (resting) => cancelDecision(resting, symbol),
  });
  return { ...arm, nativeTrailed, nativeUnavailable };
};
