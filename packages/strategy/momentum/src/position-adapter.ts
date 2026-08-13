// Position-state capability: maps momentum's persisted body onto the generic
// `PositionStateAdapter` the worker's boot reconcilers and fill-adopter drive.
// This is where momentum's field names (`entryPrice`, `highSinceEntry`,
// `heldQuantity`) and `schemaVersion` literal live — the worker stays
// plugin-agnostic and only knows the generic position vocabulary.

import {
  asStringOrNull,
  currentSchemaBody,
  type AdoptedFill,
  type PositionStateAdapter,
  type PositionView,
} from '@app/strategy-core';
import { MOMENTUM_STATE_SCHEMA_VERSION, type MomentumState } from './schema.js';

// A body is usable only at the current schema; a foreign / un-migrated body
// reads as `null` so the worker defers it. Closes over momentum's schema
// version over the shared core guard.
const asCurrentBody = (state: unknown): Record<string, unknown> | null =>
  currentSchemaBody(MOMENTUM_STATE_SCHEMA_VERSION, state);

/**
 * Momentum's implementation of the position capability. Every method validates
 * the body is a current-schema momentum body and returns `null` (no-op) when it
 * is not, never throwing. The generic `avgEntryPrice` maps to momentum's
 * `entryPrice`.
 */
export const momentumPositionAdapter: PositionStateAdapter<MomentumState> = {
  readPosition(state): PositionView | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    const avgEntryPrice = asStringOrNull(body['entryPrice']);
    const heldQuantity = asStringOrNull(body['heldQuantity']);
    if (avgEntryPrice === undefined || heldQuantity === undefined) return null;
    return { avgEntryPrice, heldQuantity };
  },

  applyFill(state, fill: AdoptedFill): MomentumState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    switch (fill.kind) {
      case 'buy':
        // New entry / add: set entry price + held qty and reset BOTH high-water
        // marks so a fresh trailing cycle starts on each leg.
        //
        // `profitTrailSinceMs` clears with them. It is the epoch bounding which
        // 1m closes may ratchet the profit trail, and it belongs to the entry
        // this fill just replaced. Carried forward it would admit closes from
        // before the new cost basis, seeding the mark with a peak this position
        // never held and arming the trail into an immediate sell. The adapter
        // sees no candle window to derive a fresh one, so it clears the field and
        // the next held tick establishes it.
        //
        // `lastEntryCandleMs` deliberately survives. It is the one-entry-per-cross
        // guard, and this adapter runs for the profile's OWN strategy entries as
        // well as adopted ones, so clearing it would erase the stamp the placing
        // tick just wrote and let the same cross re-enter after a stop-out. A
        // stale stamp only ever suppresses an entry on a candle already past.
        return {
          ...(body as unknown as MomentumState),
          entryPrice: fill.avgEntryPrice,
          heldQuantity: fill.heldQuantity,
          highSinceEntry: null,
          profitHigh: null,
          profitTrailSinceMs: null,
        };
      case 'sell-reduce':
        // Partial exit: lower held qty only; entry / high-water stay intact.
        return { ...(body as unknown as MomentumState), heldQuantity: fill.heldQuantity };
      case 'empty': {
        // Full exit: flatten. Skip the write when already flat so a duplicate
        // clear does not churn the row.
        if (
          body['entryPrice'] === null &&
          body['highSinceEntry'] === null &&
          (body['heldQuantity'] === null || body['heldQuantity'] === undefined)
        ) {
          return null;
        }
        return {
          ...(body as unknown as MomentumState),
          entryPrice: null,
          heldQuantity: null,
          highSinceEntry: null,
          profitHigh: null,
          profitTrailSinceMs: null,
        };
      }
    }
  },

  setHeldQuantity(state, heldQuantity): MomentumState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    return { ...(body as unknown as MomentumState), heldQuantity };
  },

  setAvgEntryPrice(state, avgEntryPrice): MomentumState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    return { ...(body as unknown as MomentumState), entryPrice: avgEntryPrice };
  },

  clearPosition(state): MomentumState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    // Clear entry price + both high-water marks together; held qty is pinned
    // to wallet truth separately by the held-quantity reconciler. Momentum has
    // no grid, so the `resetGridIndex` option is inert here — ignored.
    return {
      ...(body as unknown as MomentumState),
      entryPrice: null,
      highSinceEntry: null,
      profitHigh: null,
      profitTrailSinceMs: null,
    };
  },
};
