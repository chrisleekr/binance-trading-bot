// Position-state capability: maps TT's persisted body onto the generic
// `PositionStateAdapter` the worker's boot reconcilers and fill-adopter
// drive. This is where TT's field names (`avgEntryPrice`, `heldQuantity`,
// `highSinceBuy`, `currentGridTradeIndex`) and `schemaVersion` literal
// live — the worker stays plugin-agnostic and only knows the generic
// position vocabulary.

import {
  asStringOrNull,
  clearPositionScopedFields,
  currentSchemaBody,
  hasPositionScopedFieldSet,
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
          (body['heldQuantity'] === null || body['heldQuantity'] === undefined) &&
          !hasPositionScopedFieldSet(body)
        ) {
          return null;
        }
        // The writer that ends the position closes the STATE fields the position owns. TT's tick clears these on its flat path, but that path only runs if a tick runs at all: a kill-switch or a symbol pause short-circuits `buildTickInput` first, and a disposal-blocked symbol never re-enables on its own. Scope is the body only: the paired `condition_states` row is written from the tick's audited commit, which no adapter write goes through, so that row still waits for a later tick to resolve it.
        return clearPositionScopedFields({
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
        });
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
    const flattened: TTState = {
      ...(body as unknown as TTState),
      avgEntryPrice: null,
      highSinceBuy: null,
      breakEvenArmed: false,
      // Clearing the cost basis ends the bull pyramid and a discovery
      // single-entry too — reset their markers so a re-entry starts fresh as a
      // normal grid position (mirrors the full-exit reset above).
      ...clearedAddTracking(),
    };
    // This clear forgets the cost basis and KEEPS the coins, so unlike the full-exit fill above it does not end the position. A stop or exit refusal on a still-held balance still describes a real, still-unguarded holding, and dropping it here would delete the operator's only in-state warning while the exposure is live. Only a body with nothing left to protect may have it cleared.
    //
    // Strictly `=== null`, which `asStringOrNull` returns only for an absent or explicitly null quantity. A malformed value comes back `undefined`, and the one safe reading of "I cannot tell whether coins are held" is to keep the warning.
    //
    // Deliberately stricter than TT's tick, which clears on the cost basis alone. The tick re-derives the refusal from live exchange state every run, so it may retire a record it can replace; this writer cannot re-derive anything, and the paths that reach it without a tick are exactly the ones where nothing will raise the warning again.
    const cleared: TTState =
      asStringOrNull(body['heldQuantity']) === null
        ? clearPositionScopedFields(flattened)
        : flattened;
    // `reset-grid-trade` (resetGridIndex) also abandons the current grid
    // cycle: clear the index so the next entry re-fires level 0, whose
    // precondition is `currentGridTradeIndex === null` (mirrors the full-exit
    // reset in `applyFill('empty')` and the tick sell-reset).
    return opts?.resetGridIndex ? { ...cleared, currentGridTradeIndex: null } : cleared;
  },
};
