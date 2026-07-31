import { describe, it, expect } from 'vitest';
import { trailingTradePositionAdapter, type TTState } from '../src/index.js';
import { initialTTState } from '../src/schema.js';

const base = (overrides: Partial<TTState> = {}): TTState => ({
  ...initialTTState(),
  ...overrides,
});

describe('trailingTradePositionAdapter.readPosition', () => {
  it('projects avgEntryPrice + heldQuantity from a current-schema body', () => {
    const view = trailingTradePositionAdapter.readPosition(
      base({ avgEntryPrice: '50000', heldQuantity: '0.5' }),
    );
    expect(view).toEqual({ avgEntryPrice: '50000', heldQuantity: '0.5' });
  });

  it('returns nulls for an unset (seeded) position', () => {
    expect(trailingTradePositionAdapter.readPosition(initialTTState())).toEqual({
      avgEntryPrice: null,
      heldQuantity: null,
    });
  });

  it('returns null for a non-object body', () => {
    expect(trailingTradePositionAdapter.readPosition(null as unknown as TTState)).toBeNull();
    expect(trailingTradePositionAdapter.readPosition('nope' as unknown as TTState)).toBeNull();
  });

  it('returns null for an older / foreign schema version', () => {
    expect(
      trailingTradePositionAdapter.readPosition({
        schemaVersion: '1.0.0',
        avgEntryPrice: '50000',
      } as unknown as TTState),
    ).toBeNull();
  });

  it('returns null when a position field is malformed (non-string/non-null)', () => {
    expect(
      trailingTradePositionAdapter.readPosition({
        schemaVersion: '2.0.0',
        heldQuantity: 42,
      } as unknown as TTState),
    ).toBeNull();
    expect(
      trailingTradePositionAdapter.readPosition({
        schemaVersion: '2.0.0',
        avgEntryPrice: 42,
      } as unknown as TTState),
    ).toBeNull();
  });
});

describe('trailingTradePositionAdapter.applyFill', () => {
  it('buy sets entry price + held quantity and resets the trailing high-water mark', () => {
    const next = trailingTradePositionAdapter.applyFill(
      base({ avgEntryPrice: null, heldQuantity: null, highSinceBuy: '999' }),
      { kind: 'buy', avgEntryPrice: '60000', heldQuantity: '0.25' },
    ) as TTState;
    expect(next.avgEntryPrice).toBe('60000');
    expect(next.heldQuantity).toBe('0.25');
    expect(next.highSinceBuy).toBeNull();
  });

  it('sell-reduce lowers held quantity only, leaving avgEntryPrice + grid index intact', () => {
    const next = trailingTradePositionAdapter.applyFill(
      base({
        avgEntryPrice: '60000',
        heldQuantity: '0.5',
        highSinceBuy: '65000',
        currentGridTradeIndex: 2,
      }),
      { kind: 'sell-reduce', heldQuantity: '0.2' },
    ) as TTState;
    expect(next.heldQuantity).toBe('0.2');
    expect(next.avgEntryPrice).toBe('60000');
    expect(next.highSinceBuy).toBe('65000');
    expect(next.currentGridTradeIndex).toBe(2);
  });

  it('empty flattens the position and clears the grid index to null so the next entry can re-fire level 0', () => {
    const next = trailingTradePositionAdapter.applyFill(
      base({
        avgEntryPrice: '60000',
        heldQuantity: '0.5',
        highSinceBuy: '65000',
        currentGridTradeIndex: 3,
        bullAddCount: 2,
        lastBullAddPrice: '64000',
        discoveryEntry: true,
        entryAtMs: 1_700_000_000_000,
      }),
      { kind: 'empty' },
    ) as TTState;
    expect(next.avgEntryPrice).toBeNull();
    expect(next.heldQuantity).toBeNull();
    expect(next.highSinceBuy).toBeNull();
    // A discovery single-entry's marker must clear on full exit, or a stale
    // flag would suppress the NEXT (non-discovery) position's grid promotions.
    expect(next.discoveryEntry).toBe(false);
    expect(next.entryAtMs).toBeNull();
    // Flat = no grid position. The grid entry precondition is
    // `currentGridTradeIndex === null`; a leftover 0 (the transient
    // "level-0 held" shape, which orphan-recovery never resets) would wedge
    // the strategy so it never re-enters after a full exit.
    expect(next.currentGridTradeIndex).toBeNull();
    // The bull-pyramid counters reset too — the `buy` fill case spreads ...body,
    // so a stale count would otherwise cap/misfire the next position's pyramid.
    expect(next.bullAddCount).toBeNull();
    expect(next.lastBullAddPrice).toBeNull();
  });

  it('empty is a no-op (null) when the position is already flat', () => {
    expect(
      trailingTradePositionAdapter.applyFill(
        base({ avgEntryPrice: null, heldQuantity: null, highSinceBuy: null }),
        { kind: 'empty' },
      ),
    ).toBeNull();
  });

  it('empty is a no-op (null) when already flat with heldQuantity absent', () => {
    // A pre-fill body can lack the heldQuantity key entirely; the flat check
    // treats an undefined held quantity the same as null.
    const flatNoHeld = {
      schemaVersion: '2.0.0',
      avgEntryPrice: null,
      highSinceBuy: null,
    } as unknown as TTState;
    expect(trailingTradePositionAdapter.applyFill(flatNoHeld, { kind: 'empty' })).toBeNull();
  });

  it('returns null for a non-object body', () => {
    expect(
      trailingTradePositionAdapter.applyFill(null as unknown as TTState, { kind: 'empty' }),
    ).toBeNull();
  });
});

describe('trailingTradePositionAdapter setters', () => {
  it('setHeldQuantity pins the quantity (incl. null) without touching other fields', () => {
    const next = trailingTradePositionAdapter.setHeldQuantity(
      base({ avgEntryPrice: '60000', heldQuantity: '0.5' }),
      '0.3',
    ) as TTState;
    expect(next.heldQuantity).toBe('0.3');
    expect(next.avgEntryPrice).toBe('60000');

    const cleared = trailingTradePositionAdapter.setHeldQuantity(base(), null) as TTState;
    expect(cleared.heldQuantity).toBeNull();
  });

  it('setAvgEntryPrice revives the entry price, leaving highSinceBuy untouched', () => {
    const next = trailingTradePositionAdapter.setAvgEntryPrice(
      base({ avgEntryPrice: null, highSinceBuy: null }),
      '42000',
    ) as TTState;
    expect(next.avgEntryPrice).toBe('42000');
    expect(next.highSinceBuy).toBeNull();
  });

  it('setters return null for a non-object body', () => {
    expect(
      trailingTradePositionAdapter.setHeldQuantity(null as unknown as TTState, '1'),
    ).toBeNull();
    expect(
      trailingTradePositionAdapter.setAvgEntryPrice(null as unknown as TTState, '1'),
    ).toBeNull();
  });
});

describe('trailingTradePositionAdapter.clearPosition', () => {
  it('clears entry price + trailing high-water mark, keeping the grid index by default', () => {
    const next = trailingTradePositionAdapter.clearPosition(
      base({
        avgEntryPrice: '60000',
        highSinceBuy: '65000',
        heldQuantity: '0.5',
        currentGridTradeIndex: 2,
      }),
    ) as TTState;
    expect(next.avgEntryPrice).toBeNull();
    expect(next.highSinceBuy).toBeNull();
    // heldQuantity is pinned separately by the wallet reconciler; the grid
    // index survives a phantom-ledger prune (only reset-grid abandons it).
    expect(next.heldQuantity).toBe('0.5');
    expect(next.currentGridTradeIndex).toBe(2);
  });

  it('also clears the grid index with { resetGridIndex: true } (reset-grid-trade)', () => {
    const next = trailingTradePositionAdapter.clearPosition(
      base({
        avgEntryPrice: '50000',
        highSinceBuy: '52000',
        currentGridTradeIndex: 2,
        bullAddCount: 1,
        lastBullAddPrice: '51000',
        discoveryEntry: true,
        entryAtMs: 1_700_000_000_000,
      }),
      { resetGridIndex: true },
    ) as TTState;
    expect(next.avgEntryPrice).toBeNull();
    expect(next.highSinceBuy).toBeNull();
    expect(next.currentGridTradeIndex).toBeNull();
    // Clearing the cost basis ends the pyramid: counters reset.
    expect(next.bullAddCount).toBeNull();
    expect(next.lastBullAddPrice).toBeNull();
    // Clearing the cost basis also ends a discovery single-entry: marker resets.
    expect(next.discoveryEntry).toBe(false);
    expect(next.entryAtMs).toBeNull();
  });

  it('preserves unrelated state fields', () => {
    const start = base({ avgEntryPrice: '50000', currentGridTradeIndex: 1, disabledUntilMs: 123 });
    const next = trailingTradePositionAdapter.clearPosition(start, { resetGridIndex: true });
    expect(next?.disabledUntilMs).toBe(123);
    expect(next?.schemaVersion).toBe(start.schemaVersion);
  });

  it('returns the cleared body even when already clear (idempotent for retry)', () => {
    const next = trailingTradePositionAdapter.clearPosition(base(), { resetGridIndex: true });
    expect(next).not.toBeNull();
    expect(next?.avgEntryPrice).toBeNull();
    expect(next?.currentGridTradeIndex).toBeNull();
  });

  it('returns null for a non-object body', () => {
    expect(trailingTradePositionAdapter.clearPosition(null as unknown as TTState)).toBeNull();
    expect(trailingTradePositionAdapter.clearPosition('nope' as unknown as TTState)).toBeNull();
  });

  it('returns null for an older / foreign schema version (defer, do not mutate)', () => {
    expect(
      trailingTradePositionAdapter.clearPosition(
        {
          schemaVersion: '1.0.0',
          avgEntryPrice: '50000',
          currentGridTradeIndex: 3,
        } as unknown as TTState,
        { resetGridIndex: true },
      ),
    ).toBeNull();
  });
});
