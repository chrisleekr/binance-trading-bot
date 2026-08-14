import { roundToTick } from '@app/money';
import {
  evaluateProtectiveStopArm as coreEvaluateProtectiveStopArm,
  findRestingProtectiveStop as coreFindRestingProtectiveStop,
  clampedStopDrift,
  parseFilters,
} from '@app/strategy-core';
import type {
  Decision,
  DesiredNativeTrailingStop,
  OpenOrder,
  ProtectiveStopArm,
  ProtectiveStopLevel,
  TickInput,
} from '@app/strategy-core';
import { protectiveStopClientOrderId } from '../client-order-id.js';
import { buildProtectiveStopCancel, buildSellDecision } from '../decisions.js';
import type { TTBundle, TTConfig, TTState } from '../schema.js';
import { resolveTTStopLevel, ttStopBandSettings } from '../stop-level.js';
import { reclaimableOwnSellBase } from './sell-gate.js';
import { safeDecimal } from './safe-decimal.js';

type TTInput = TickInput<TTConfig, TTState, TTBundle>;

// The shared arm's blocker shape is exactly this strategy's persisted
// `protectiveStopBlocker` field, so tick() assigns it straight into nextState.
export type { ProtectiveStopArm } from '@app/strategy-core';

/**
 * The shared arm's outcome plus the two ways the exchange price band quietly
 * moved this stop off the configured one — raised to the band floor, or swapped
 * for an exchange-native trail. Neither leaves a blocker behind, because in the
 * end nothing was refused, so without these flags both are invisible to the tick
 * that has to report them.
 */
export interface TTProtectiveStopArm extends ProtectiveStopArm {
  readonly floorClamped: boolean;
  readonly nativeTrailed: boolean;
}

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
const computeProtectiveStopLevel = (
  input: TTInput,
  state: TTState,
): { readonly level: ProtectiveStopLevel | null; readonly floorClamped: boolean } => {
  const none = { level: null, floorClamped: false };
  // The caller's `protectiveStop?.enabled === true` guard already proved the
  // block is present before reaching here, so reading the offset directly is
  // safe (a raw stored config without the block never gets past that guard).
  const { protectiveStop, stopLossPercentage } = input.config.sell;
  const avgEntry = state.avgEntryPrice === null ? null : safeDecimal(state.avgEntryPrice);
  if (avgEntry === null || avgEntry.lte(0)) return none;

  // Only arm against a TRACKED position. A null / non-positive heldQuantity
  // means the bot holds nothing to protect; never rest a SELL against
  // operator-held base the bot does not manage.
  const held = state.heldQuantity === null ? null : safeDecimal(state.heldQuantity);
  if (held === null || held.lte(0)) return none;

  // No stop configured ⇒ no protective stop. The schema constrains
  // stopLossPercentage to empty / '0' / (0, 1]; a value >= 1 (e.g. '1') stops
  // at or above entry, which is not a loss-side stop, so treat it as unset too.
  const stopPct = safeDecimal(stopLossPercentage);
  if (stopPct === null || stopPct.lte(0) || stopPct.gte(1)) return none;

  const tick = safeDecimal(input.market.symbolInfo.filters.tickSize);
  const offset = safeDecimal(protectiveStop.limitOffsetPercentage);
  const filters = parseFilters(input.market.symbolInfo.filters);
  if (tick === null || tick.lte(0) || offset === null || filters === null) return none;

  // Same resolver the sell gate and the preview read, so all three name one
  // level. `roundToTick` floors, which can drop a clamped trigger back under the
  // exchange floor by at most one tick — absorbed by the resolver's margin, which
  // is percentage-scale where a tick is not.
  const { stop: rawStop, floorClamped } = resolveTTStopLevel({
    avgEntry,
    stopPct,
    protectiveStop,
    bandContext: {
      reference: input.market.currentPrice,
      band: input.market.symbolInfo.filters.percentPriceBySide,
    },
  });
  const stop = roundToTick(rawStop, tick);
  const limit = roundToTick(stop.mul(offset), tick);
  if (stop.lte(0) || limit.lte(0)) return none;
  return { level: { stop, limit, held, filters, tick }, floorClamped };
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
export const evaluateProtectiveStop = (input: TTInput, state: TTState): TTProtectiveStopArm => {
  const symbol = input.market.symbol;
  const ourId = protectiveStopClientOrderId(input.profile.id, symbol);
  // Optional chaining tolerates a raw stored config that predates the field (the
  // live worker does not schema-parse): undefined ⇒ disabled. The level is
  // computed only when enabled, because `computeProtectiveStopLevel` reads the
  // block's offset directly on the proof the guard already established.
  const enabled = input.config.sell.protectiveStop?.enabled === true;
  // Same optional-chaining discipline: a stored config saved before this leaf
  // existed carries no `onBandBlock` key, which reads as the `notify` default.
  // Routed through the band settings so the trail distance and the operator
  // warning quote ONE derivation of `sell.stopLossPercentage`; null here means the
  // fraction is unusable, which is a reason not to offer the escape at all.
  const bandSettings = ttStopBandSettings(input.config);
  const nativeTrail = bandSettings !== null && bandSettings.onBandBlock === 'native-trail';
  const resolved = enabled
    ? computeProtectiveStopLevel(input, state)
    : { level: null, floorClamped: false };
  // Set from inside the builder rather than inferred from the returned
  // decisions: the shared arm calls it EXACTLY when it substitutes a trail for a
  // band-refused priced stop, which is the fact worth reporting. Reading the
  // decisions back would re-derive that from the order shape and drift the day
  // the trail gains another use.
  let nativeTrailed = false;
  const arm = coreEvaluateProtectiveStopArm({
    input,
    enabled,
    level: resolved.level,
    // A closing batch cancels our own resting stop before the market sell, so the
    // base it locks is reclaimable here — otherwise `free` reads zero the moment
    // our stop rests and the arm churns every tick.
    reclaimableBase: reclaimableOwnSellBase(input),
    ourClientOrderId: ourId,
    // A clamped level is pinned to the exchange floor, which is a fraction of the
    // CURRENT price: at the shared default band the resting stop would be
    // re-placed on nearly every tick for as long as the band binds.
    ...(resolved.floorClamped ? { minStopDrift: clampedStopDrift(null) } : {}),
    buildPlace: (desired) =>
      buildSellDecision(input, 'protective-stop', desired.quantity, '', {
        stopLimit: { stopPrice: desired.stopPrice, price: desired.price },
        clientOrderId: ourId,
      }),
    // Supplied only under `native-trail`: its presence is what tells the shared
    // arm a band refusal has an escape rather than being a dead end. Same
    // clientOrderId as the priced form, so both occupy the one resting slot.
    ...(nativeTrail && bandSettings !== null
      ? {
          nativeTrail: {
            stopDistancePct: bandSettings.stopDistancePct,
            build: (desired: DesiredNativeTrailingStop) => {
              nativeTrailed = true;
              return buildSellDecision(input, 'protective-stop', desired.quantity, '', {
                trailingDelta: desired.trailingDelta,
                clientOrderId: ourId,
              });
            },
          },
        }
      : {}),
    buildCancel: (resting) => buildProtectiveStopCancel(resting, 'tt-protective-stop-superseded'),
  });
  return { ...arm, floorClamped: resolved.floorClamped, nativeTrailed };
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
