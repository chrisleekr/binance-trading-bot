import { describe, expect, it } from 'vitest';
import type { AdoptedFill } from '@app/strategy-core';
import { rebalancePositionAdapter as a } from '../src/position-adapter.js';
import { initialRebalanceState, type RebalanceState } from '../src/schema.js';

const open: RebalanceState = { schemaVersion: '1.0.0', avgEntryPrice: '100', heldQuantity: '2' };
const flat = initialRebalanceState();
const foreign = { schemaVersion: '0.0.1', avgEntryPrice: '1', heldQuantity: '1' } as unknown;

describe('rebalancePositionAdapter', () => {
  it('readPosition returns the position for a current body', () => {
    expect(a.readPosition(open)).toEqual({ avgEntryPrice: '100', heldQuantity: '2' });
  });

  it('readPosition returns null for a foreign-schema body', () => {
    expect(a.readPosition(foreign)).toBeNull();
  });

  it('readPosition reads a missing field as flat (null), and a non-string field as a deferred null', () => {
    // Absent fields → flat (asStringOrNull maps undefined to null).
    expect(a.readPosition({ schemaVersion: '1.0.0' } as unknown)).toEqual({
      avgEntryPrice: null,
      heldQuantity: null,
    });
    // A non-string field is a malformed body → defer (null).
    expect(
      a.readPosition({ schemaVersion: '1.0.0', avgEntryPrice: 123, heldQuantity: '2' } as unknown),
    ).toBeNull();
  });

  it('applyFill buy sets entry + held', () => {
    const fill: AdoptedFill = {
      kind: 'buy',
      avgEntryPrice: '120',
      heldQuantity: '3',
    } as AdoptedFill;
    expect(a.applyFill(flat, fill)).toMatchObject({ avgEntryPrice: '120', heldQuantity: '3' });
  });

  it('applyFill sell-reduce lowers held only', () => {
    const fill: AdoptedFill = { kind: 'sell-reduce', heldQuantity: '1' } as AdoptedFill;
    expect(a.applyFill(open, fill)).toMatchObject({ avgEntryPrice: '100', heldQuantity: '1' });
  });

  it('applyFill empty flattens an open position', () => {
    expect(a.applyFill(open, { kind: 'empty' } as AdoptedFill)).toMatchObject({
      avgEntryPrice: null,
      heldQuantity: null,
    });
  });

  it('applyFill empty is a no-op (null) when already flat', () => {
    expect(a.applyFill(flat, { kind: 'empty' } as AdoptedFill)).toBeNull();
    // heldQuantity absent (undefined) + entry null is also "already flat".
    expect(
      a.applyFill(
        { schemaVersion: '1.0.0', avgEntryPrice: null } as unknown,
        {
          kind: 'empty',
        } as AdoptedFill,
      ),
    ).toBeNull();
  });

  it('applyFill returns null for a foreign body', () => {
    expect(a.applyFill(foreign, { kind: 'empty' } as AdoptedFill)).toBeNull();
  });

  it('setHeldQuantity / setAvgEntryPrice / clearPosition mutate a current body and no-op a foreign one', () => {
    expect(a.setHeldQuantity(open, '9')).toMatchObject({ heldQuantity: '9' });
    expect(a.setAvgEntryPrice(open, '7')).toMatchObject({ avgEntryPrice: '7' });
    expect(a.clearPosition(open)).toMatchObject({ avgEntryPrice: null });
    expect(a.setHeldQuantity(foreign, '9')).toBeNull();
    expect(a.setAvgEntryPrice(foreign, '7')).toBeNull();
    expect(a.clearPosition(foreign)).toBeNull();
  });
});
