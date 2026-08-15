import { Decimal, roundToTick } from '@app/money';
import {
  evaluateProtectiveStopArm as coreEvaluateProtectiveStopArm,
  findRestingProtectiveStop as coreFindRestingProtectiveStop,
  clampedStopDrift,
  decOrNull,
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
import type { MomentumBundle, MomentumConfig, MomentumState } from './schema.js';

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
 * The shared arm's outcome plus whether a band refusal was answered with an
 * exchange-native trailing stop. A substitution leaves no blocker — nothing was
 * refused in the end — so without this flag the swap is invisible to the tick
 * that has to report it.
 */
export interface MomentumProtectiveStopArm extends ProtectiveStopArm {
  readonly nativeTrailed: boolean;
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
 * Cancel any resting protective stop. Prepended before a position-closing SELL
 * so the exchange does not hold a stale limit against an already-flat position.
 * Empty (the common case) when none is resting, so closing batches stay minimal.
 */
export const protectiveStopCancelDecisions = (input: MomentumInput): Decision[] => {
  const resting = findRestingProtectiveStop(
    input.openOrders,
    input.profile.id,
    input.market.symbol,
  );
  return resting === undefined ? [] : [cancelDecision(resting, input.market.symbol)];
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

/**
 * Arm or re-arm the exchange-side protective stop while holding, by resolving
 * momentum's seams — the ATR/trail level, its own reclaimable resting base, its
 * `-ps` clientOrderId, and its place/cancel builders — and handing them to the
 * shared orchestrator, which owns the full/partial sizing, the foreign-lock
 * refusal, and the re-arm drift band. An ARM, not a sell: the caller preserves
 * the position state.
 */
export const evaluateProtectiveStopArm = (
  input: MomentumInput,
  state: MomentumState,
  rawStop: Decimal | null,
  floorClamped: boolean,
): MomentumProtectiveStopArm => {
  const symbol = input.market.symbol;
  const ourId = protectiveStopClientOrderId(input.profile.id, symbol);
  // Optional chaining tolerates a stored config that predates the field (the
  // live worker does not schema-parse): undefined ⇒ disabled. The level is
  // computed only when enabled, mirroring the pre-refactor short-circuit.
  const enabled = input.config.protectiveStop?.enabled === true;
  const rawBand = decOrNull(input.config.protectiveStop?.minRearmDriftPct);
  const operatorBand = rawBand !== null && rawBand.gt(0) && rawBand.lt(1) ? rawBand : null;
  // A clamped level tracks the market, so the operator's band (or the shared
  // default) would re-place the order on nearly every tick for as long as the
  // exchange floor is what is holding the stop up.
  const driftBand = floorClamped ? clampedStopDrift(operatorBand) : operatorBand;
  // Same optional-chaining discipline: a stored config saved before this leaf
  // existed carries no `onBandBlock` key, which reads as the `notify` default.
  // Routed through the band settings so the trail distance and the operator
  // warning quote ONE derivation of `trailingStopPct`; null here means the
  // fraction is unusable, which is a reason not to offer the escape at all.
  const bandSettings = momentumStopBandSettings(input.config);
  const nativeTrail = bandSettings !== null && bandSettings.onBandBlock === 'native-trail';
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
    level: enabled && rawStop !== null ? computeProtectiveStopLevel(input, state, rawStop) : null,
    // Credit back the base our OWN resting stop locks: we cancel it in the same
    // batch that replaces it, so that base is ours to re-commit.
    reclaimableBase: ownRestingSellBase(input.openOrders, ourId, symbol),
    ourClientOrderId: ourId,
    // Operator-settable, because the profit trail can advance the level every few
    // minutes and this band is what decides how much of that reaches Binance as
    // orders. Absent / unparseable falls back to the shared default.
    ...(driftBand === null ? {} : { minStopDrift: driftBand }),
    buildPlace: (desired, rearm) => placeDecision(input, desired, rearm),
    // Supplied only under `native-trail`: its presence is what tells the shared
    // arm a band refusal has an escape rather than being a dead end.
    ...(nativeTrail && bandSettings !== null
      ? {
          nativeTrail: {
            stopDistancePct: bandSettings.stopDistancePct,
            build: (desired: DesiredNativeTrailingStop, rearm: boolean) => {
              nativeTrailed = true;
              return nativeTrailPlaceDecision(input, desired, rearm);
            },
          },
        }
      : {}),
    buildCancel: (resting) => cancelDecision(resting, symbol),
  });
  return { ...arm, nativeTrailed };
};
