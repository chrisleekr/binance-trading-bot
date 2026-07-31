import {
  asStringOrNull,
  currentSchemaBody,
  type AdoptedFill,
  type PositionStateAdapter,
  type PositionView,
} from '@app/strategy-core';
import { REBALANCE_STATE_SCHEMA_VERSION, type RebalanceState } from './schema.js';

const asCurrentBody = (state: unknown): Record<string, unknown> | null =>
  currentSchemaBody(REBALANCE_STATE_SCHEMA_VERSION, state);

/**
 * Rebalance's position capability: maps its persisted body onto the generic
 * `PositionStateAdapter` the worker's boot reconcilers and fill-adopter drive.
 * Every method returns `null` (no-op) on a foreign / un-migrated body, never
 * throwing. Field names map straight across (`avgEntryPrice`, `heldQuantity`).
 */
export const rebalancePositionAdapter: PositionStateAdapter<RebalanceState> = {
  readPosition(state): PositionView | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    const avgEntryPrice = asStringOrNull(body['avgEntryPrice']);
    const heldQuantity = asStringOrNull(body['heldQuantity']);
    if (avgEntryPrice === undefined || heldQuantity === undefined) return null;
    return { avgEntryPrice, heldQuantity };
  },

  applyFill(state, fill: AdoptedFill): RebalanceState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    switch (fill.kind) {
      case 'buy':
        return {
          ...(body as unknown as RebalanceState),
          avgEntryPrice: fill.avgEntryPrice,
          heldQuantity: fill.heldQuantity,
        };
      case 'sell-reduce':
        return { ...(body as unknown as RebalanceState), heldQuantity: fill.heldQuantity };
      case 'empty': {
        if (
          body['avgEntryPrice'] === null &&
          (body['heldQuantity'] === null || body['heldQuantity'] === undefined)
        ) {
          return null;
        }
        return { ...(body as unknown as RebalanceState), avgEntryPrice: null, heldQuantity: null };
      }
    }
  },

  setHeldQuantity(state, heldQuantity): RebalanceState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    return { ...(body as unknown as RebalanceState), heldQuantity };
  },

  setAvgEntryPrice(state, avgEntryPrice): RebalanceState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    return { ...(body as unknown as RebalanceState), avgEntryPrice };
  },

  clearPosition(state): RebalanceState | null {
    const body = asCurrentBody(state);
    if (body === null) return null;
    return { ...(body as unknown as RebalanceState), avgEntryPrice: null };
  },
};
