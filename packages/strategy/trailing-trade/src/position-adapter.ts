// Position-state capability: maps TT's persisted body onto the generic
// `PositionStateAdapter` the worker's boot reconcilers and fill-adopter
// drive. This is where TT's field names (`avgEntryPrice`, `heldQuantity`,
// `highSinceBuy`, `currentGridTradeIndex`) and `schemaVersion` literal
// live — the worker stays plugin-agnostic and only knows the generic
// position vocabulary.

import {
  asStringOrNull,
  currentSchemaBody,
  type AdoptedFill,
  type PositionStateAdapter,
  type PositionView,
} from '@app/strategy-core';
import { TT_STATE_SCHEMA_VERSION, type TTState } from './schema.js';
import { clearedAddTracking } from './position-lifecycle.js';

// A body is usable as a TT position only at the current schema; a foreign /
// un-migrated body reads as `null` so the worker defers it. Closes over TT's
// schema version over the shared core guard.
const asCurrentBody = (state: unknown): Record<string, unknown> | null =>
  currentSchemaBody(TT_STATE_SCHEMA_VERSION, state);

/**
 * TT's implementation of the position capability. Every method validates
 * the body is a current-schema TT body and returns `null` (no-op) when it
 * is not, never throwing.
 */
export const trailingTradePositionAdapter: PositionStateAdapter<TTState> = {
  readPosition(state): PositionView | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    const avgEntryPrice = asStringOrNull(body['avgEntryPrice']);
    const heldQuantity = asStringOrNull(body['heldQuantity']);
    // A populated-but-malformed position field (not string|null) is
    // unusable; defer rather than guess.
    if (avgEntryPrice === undefined || heldQuantity === undefined) return null;
    return { avgEntryPrice, heldQuantity };
  },

  applyFill(state, fill: AdoptedFill): TTState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    switch (fill.kind) {
      case 'buy':
        // New entry / add: store the weighted-average cost basis the fold
        // already computed (`fill.avgEntryPrice` is the VWAP over all buys,
        // NOT this fill's own price) + held qty, and reset the trailing
        // high-water mark so a fresh trailing cycle starts.
        return {
          ...(body as unknown as TTState),
          avgEntryPrice: fill.avgEntryPrice,
          heldQuantity: fill.heldQuantity,
          highSinceBuy: null,
          // A new entry / add restarts the trailing cycle, so the break-even
          // stop must re-arm from the new cost basis (mirrors highSinceBuy).
          breakEvenArmed: false,
        };
      case 'sell-reduce':
        // Partial exit: lower held qty only; avgEntryPrice / highSinceBuy /
        // grid index stay intact for the remaining slug.
        return { ...(body as unknown as TTState), heldQuantity: fill.heldQuantity };
      case 'empty': {
        // Full exit: flatten. Skip the write when already flat so a
        // duplicate clear does not churn the row.
        if (
          body['avgEntryPrice'] === null &&
          body['highSinceBuy'] === null &&
          (body['heldQuantity'] === null || body['heldQuantity'] === undefined)
        ) {
          return null;
        }
        return {
          ...(body as unknown as TTState),
          avgEntryPrice: null,
          heldQuantity: null,
          highSinceBuy: null,
          breakEvenArmed: false,
          // Flat means no grid position: the next entry must re-fire level 0,
          // whose precondition is `currentGridTradeIndex === null` (0 is the
          // transient "level-0 emitted/held" shape, which orphan-recovery
          // deliberately never resets). Setting 0 here wedged the strategy after
          // its first full exit — entry could not fire, so it never re-entered.
          // Mirrors the tick sell-reset, which clears the index to null.
          currentGridTradeIndex: null,
          // Reset the bull-pyramid + discovery markers with the position so a
          // fresh entry starts a new pyramid as a normal grid position (the
          // `buy` case spreads ...body, carrying these over, so they MUST be
          // reset here on full exit).
          ...clearedAddTracking(),
        };
      }
    }
  },

  setHeldQuantity(state, heldQuantity): TTState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    return { ...(body as unknown as TTState), heldQuantity };
  },

  setAvgEntryPrice(state, avgEntryPrice): TTState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    return { ...(body as unknown as TTState), avgEntryPrice };
  },

  clearPosition(state, opts): TTState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    // Clear entry price + trailing high-water mark together; held qty is
    // pinned to wallet truth separately by the held-quantity reconciler.
    const cleared: TTState = {
      ...(body as unknown as TTState),
      avgEntryPrice: null,
      highSinceBuy: null,
      breakEvenArmed: false,
      // Clearing the cost basis ends the bull pyramid and a discovery
      // single-entry too — reset their markers so a re-entry starts fresh as a
      // normal grid position (mirrors the full-exit reset above).
      ...clearedAddTracking(),
    };
    // `reset-grid-trade` (resetGridIndex) also abandons the current grid
    // cycle: clear the index so the next entry re-fires level 0, whose
    // precondition is `currentGridTradeIndex === null` (mirrors the full-exit
    // reset in `applyFill('empty')` and the tick sell-reset).
    return opts?.resetGridIndex ? { ...cleared, currentGridTradeIndex: null } : cleared;
  },
};
