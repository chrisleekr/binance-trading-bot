import { Decimal, roundToTick } from '@app/money';
import {
  evaluateProtectiveStopArm as coreEvaluateProtectiveStopArm,
  findRestingProtectiveStop as coreFindRestingProtectiveStop,
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
import { atrTrailingStopPrice } from './trailing-stop.js';
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
 * The level the resting stop must sit at: the SAME one the in-process trail uses
 * — the ATR chandelier when `atrTrailingStop` is enabled and computable, else
 * `effectiveHigh × (1 - trailingStopPct)` — so the resting order is a faithful
 * backstop, not a second, looser stop. Null when there is nothing to protect
 * (flat, no tracked quantity) or an input does not parse. This level formula is
 * the one genuine per-strategy seam the shared arm cannot own.
 */
const computeProtectiveStopLevel = (
  input: MomentumInput,
  state: MomentumState,
  effectiveHigh: Decimal,
): ProtectiveStopLevel | null => {
  if (state.entryPrice === null) return null;
  const held = state.heldQuantity === null ? null : safeDecimal(state.heldQuantity);
  if (held === null || held.lte(0)) return null;

  const closed = (input.market.candlesByInterval[input.config.candleInterval] ?? []).filter(
    (c) => c.isClosed,
  );
  const atrStop = atrTrailingStopPrice(input.config, closed, effectiveHigh);
  let rawStop: Decimal;
  if (atrStop !== null) {
    rawStop = atrStop;
  } else {
    const trailPct = safeDecimal(input.config.trailingStopPct);
    if (trailPct === null || trailPct.lte(0) || trailPct.gte(1)) return null;
    rawStop = effectiveHigh.mul(new Decimal(1).minus(trailPct));
  }

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

const placeDecision = (input: MomentumInput, desired: DesiredProtectiveStop): Decision => ({
  type: 'place-order',
  intent: {
    symbol: input.market.symbol,
    side: 'SELL',
    reason: 'protective-stop',
    clientOrderId: protectiveStopClientOrderId(input.profile.id, input.market.symbol),
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
  effectiveHigh: Decimal,
): ProtectiveStopArm => {
  const symbol = input.market.symbol;
  const ourId = protectiveStopClientOrderId(input.profile.id, symbol);
  // Optional chaining tolerates a stored config that predates the field (the
  // live worker does not schema-parse): undefined ⇒ disabled. The level is
  // computed only when enabled, mirroring the pre-refactor short-circuit.
  const enabled = input.config.protectiveStop?.enabled === true;
  return coreEvaluateProtectiveStopArm({
    input,
    enabled,
    level: enabled ? computeProtectiveStopLevel(input, state, effectiveHigh) : null,
    // Credit back the base our OWN resting stop locks: we cancel it in the same
    // batch that replaces it, so that base is ours to re-commit.
    reclaimableBase: ownRestingSellBase(input.openOrders, ourId, symbol),
    ourClientOrderId: ourId,
    buildPlace: (desired) => placeDecision(input, desired),
    buildCancel: (resting) => cancelDecision(resting, symbol),
  });
};
