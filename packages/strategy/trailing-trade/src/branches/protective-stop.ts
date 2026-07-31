import { roundToTick } from '@app/money';
import {
  evaluateProtectiveStopArm as coreEvaluateProtectiveStopArm,
  findRestingProtectiveStop as coreFindRestingProtectiveStop,
  parseFilters,
} from '@app/strategy-core';
import type {
  Decision,
  OpenOrder,
  ProtectiveStopArm,
  ProtectiveStopLevel,
  TickInput,
} from '@app/strategy-core';
import { protectiveStopClientOrderId } from '../client-order-id.js';
import { buildProtectiveStopCancel, buildSellDecision } from '../decisions.js';
import type { TTBundle, TTConfig, TTState } from '../schema.js';
import { reclaimableOwnSellBase } from './sell-gate.js';
import { safeDecimal } from './safe-decimal.js';

type TTInput = TickInput<TTConfig, TTState, TTBundle>;

// The shared arm's blocker shape is exactly this strategy's persisted
// `protectiveStopBlocker` field, so tick() assigns it straight into nextState.
export type { ProtectiveStopArm } from '@app/strategy-core';

/**
 * The resting exchange-side protective stop for this (profile, symbol), keyed on
 * trailing-trade's `-x` clientOrderId scheme. Thin binding of that scheme to the
 * shared finder — the `isRestingSell` denylist and identity match live in
 * `@app/strategy-core`, single-sourced with the momentum strategy.
 */
export const findRestingProtectiveStop = (
  openOrders: readonly OpenOrder[],
  profileId: string,
  symbol: string,
): OpenOrder | undefined =>
  coreFindRestingProtectiveStop(openOrders, protectiveStopClientOrderId(profileId, symbol));

/**
 * The stop level: a resting STOP_LOSS_LIMIT at `avgEntryPrice × stopLossPercentage`,
 * mirroring the in-process stop-loss so the resting order is a faithful backstop.
 * Null when there is nothing to protect (flat / no tracked quantity), no loss-side
 * stop is configured, or an input does not parse. This level formula is the one
 * genuine per-strategy seam the shared arm cannot own.
 */
const computeProtectiveStopLevel = (input: TTInput, state: TTState): ProtectiveStopLevel | null => {
  // The caller's `protectiveStop?.enabled === true` guard already proved the
  // block is present before reaching here, so reading the offset directly is
  // safe (a raw stored config without the block never gets past that guard).
  const { protectiveStop, stopLossPercentage } = input.config.sell;
  const avgEntry = state.avgEntryPrice === null ? null : safeDecimal(state.avgEntryPrice);
  if (avgEntry === null || avgEntry.lte(0)) return null;

  // Only arm against a TRACKED position. A null / non-positive heldQuantity
  // means the bot holds nothing to protect; never rest a SELL against
  // operator-held base the bot does not manage.
  const held = state.heldQuantity === null ? null : safeDecimal(state.heldQuantity);
  if (held === null || held.lte(0)) return null;

  // No stop configured ⇒ no protective stop. The schema constrains
  // stopLossPercentage to empty / '0' / (0, 1]; a value >= 1 (e.g. '1') stops
  // at or above entry, which is not a loss-side stop, so treat it as unset too.
  const stopPct = safeDecimal(stopLossPercentage);
  if (stopPct === null || stopPct.lte(0) || stopPct.gte(1)) return null;

  const tick = safeDecimal(input.market.symbolInfo.filters.tickSize);
  const offset = safeDecimal(protectiveStop.limitOffsetPercentage);
  const filters = parseFilters(input.market.symbolInfo.filters);
  if (tick === null || tick.lte(0) || offset === null || filters === null) return null;

  const stop = roundToTick(avgEntry.mul(stopPct), tick);
  const limit = roundToTick(stop.mul(offset), tick);
  if (stop.lte(0) || limit.lte(0)) return null;
  return { stop, limit, held, filters, tick };
};

/**
 * Arm or re-arm the exchange-side protective stop by resolving trailing-trade's
 * seams — the `avgEntry × stopLoss` level, its own reclaimable resting base, its
 * `-x` clientOrderId, and its place/cancel builders — and handing them to the
 * shared orchestrator, which owns the full/partial sizing, the foreign-lock
 * refusal, and the re-arm drift band. An ARM, not a sell: callers preserve the
 * position state. The resting order is cancelled explicitly by the closing batch
 * when the position exits.
 */
export const evaluateProtectiveStop = (input: TTInput, state: TTState): ProtectiveStopArm => {
  const symbol = input.market.symbol;
  const ourId = protectiveStopClientOrderId(input.profile.id, symbol);
  // Optional chaining tolerates a raw stored config that predates the field (the
  // live worker does not schema-parse): undefined ⇒ disabled. The level is
  // computed only when enabled, because `computeProtectiveStopLevel` reads the
  // block's offset directly on the proof the guard already established.
  const enabled = input.config.sell.protectiveStop?.enabled === true;
  return coreEvaluateProtectiveStopArm({
    input,
    enabled,
    level: enabled ? computeProtectiveStopLevel(input, state) : null,
    // A closing batch cancels our own resting stop before the market sell, so the
    // base it locks is reclaimable here — otherwise `free` reads zero the moment
    // our stop rests and the arm churns every tick.
    reclaimableBase: reclaimableOwnSellBase(input),
    ourClientOrderId: ourId,
    buildPlace: (desired) =>
      buildSellDecision(input, 'protective-stop', desired.quantity, '', {
        stopLimit: { stopPrice: desired.stopPrice, price: desired.price },
        clientOrderId: ourId,
      }),
    buildCancel: (resting) => buildProtectiveStopCancel(resting, 'tt-protective-stop-superseded'),
  });
};

/**
 * Decisions-only view of {@link evaluateProtectiveStop}, for callers that act on
 * the orders and do not persist the blocker.
 */
export const evaluateProtectiveStopArm = (input: TTInput, state: TTState): Decision[] =>
  evaluateProtectiveStop(input, state).decisions;

/**
 * Cancel decisions to prepend before any position-closing SELL: a resting
 * protective stop must be retracted before the market sell so the exchange does
 * not hold a stale limit order against an already-flat position. Empty when no
 * protective stop is resting (the common case, so closing batches stay
 * byte-identical for profiles that never armed one).
 */
export const protectiveStopCancelDecisions = (input: TTInput): Decision[] => {
  const resting = findRestingProtectiveStop(
    input.openOrders,
    input.profile.id,
    input.market.symbol,
  );
  return resting === undefined
    ? []
    : [buildProtectiveStopCancel(resting, 'tt-protective-stop-superseded')];
};
