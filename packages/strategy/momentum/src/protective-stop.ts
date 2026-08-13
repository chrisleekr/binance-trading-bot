import { Decimal, roundToTick } from '@app/money';
import {
  evaluateProtectiveStopArm as coreEvaluateProtectiveStopArm,
  findRestingProtectiveStop as coreFindRestingProtectiveStop,
  decOrNull,
  ownRestingSellBase,
  parseFilters,
} from '@app/strategy-core';
import type {
  Decision,
  DesiredProtectiveStop,
  OpenOrder,
  ProtectiveStopArm,
  ProtectiveStopLevel,
  TickInput,
} from '@app/strategy-core';

import { protectiveStopClientOrderId } from './client-order-id.js';
import type { MomentumBundle, MomentumConfig, MomentumState } from './schema.js';

type MomentumInput = TickInput<MomentumConfig, MomentumState, MomentumBundle>;

// Default limit offset when a stored config predates the field: 2% below the
// trigger so a tripped STOP_LOSS_LIMIT crosses the book.
const DEFAULT_LIMIT_OFFSET = '0.98';

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
): ProtectiveStopArm => {
  const symbol = input.market.symbol;
  const ourId = protectiveStopClientOrderId(input.profile.id, symbol);
  // Optional chaining tolerates a stored config that predates the field (the
  // live worker does not schema-parse): undefined ⇒ disabled. The level is
  // computed only when enabled, mirroring the pre-refactor short-circuit.
  const enabled = input.config.protectiveStop?.enabled === true;
  const rawBand = decOrNull(input.config.protectiveStop?.minRearmDriftPct);
  const driftBand = rawBand !== null && rawBand.gt(0) && rawBand.lt(1) ? rawBand : null;
  return coreEvaluateProtectiveStopArm({
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
    buildCancel: (resting) => cancelDecision(resting, symbol),
  });
};
