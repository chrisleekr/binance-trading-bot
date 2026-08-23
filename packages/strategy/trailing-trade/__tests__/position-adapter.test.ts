import { describe, it, expect } from 'vitest';
import { POSITION_SCOPED_STATE_FIELDS, type PositionScopedField } from '@app/strategy-core';
import { trailingTradePositionAdapter, type TTState } from '../src/index.js';
import { initialTTState, TTStateSchema } from '../src/schema.js';

const base = (overrides: Partial<TTState> = {}): TTState => ({
  ...initialTTState(),
  ...overrides,
});

// Driven off the exported vocabulary, not a hand-copy. The core list is declared as a value precisely so a plugin suite covers whatever is on it today; hard-coding the two names here would let a third field ship through both adapter paths with every test still green.
const SCOPED_FIELDS = POSITION_SCOPED_STATE_FIELDS.filter((f) => f in TTStateSchema.shape);

// Blocker values TT can actually produce. A reason outside the field's schema enum parses nowhere in the real system, so asserting against one would pin behaviour on a body the strategy can never hold. A total Record, not a ternary with a fallback: a field added to the core list is then a typecheck failure here rather than a case that silently seeds the wrong key and passes against a schema default.
const BLOCKER_FIXTURE: Record<PositionScopedField, Partial<TTState>> = {
  protectiveStopBlocker: { protectiveStopBlocker: { reason: 'base-below-exchange-minimum' } },
  exitBlocker: { exitBlocker: { reason: 'no-exit-configured' } },
};

const blockerFor = (field: PositionScopedField): Partial<TTState> => BLOCKER_FIXTURE[field];

const allBlockersSet = (): Partial<TTState> =>
  Object.assign({}, ...SCOPED_FIELDS.map(blockerFor)) as Partial<TTState>;

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

  it('covers every position-scoped field TT declares', () => {
    // Guards the filter above: a typo in the core list matches no schema key and would silently reduce every derived test below to a no-op.
    expect(SCOPED_FIELDS).toEqual(['protectiveStopBlocker', 'exitBlocker']);
  });

  it.each(SCOPED_FIELDS)('clears %s on the fill that flattens the position', (field) => {
    // TT's tick already clears these on its flat path, but that path only runs if a tick runs at all: a kill-switch or a symbol pause short-circuits `buildTickInput` before the strategy is reached, and a disposal-blocked symbol never re-enables on its own. The writer that ends the position is the one that can close the records without depending on a later tick.
    const held = base({ avgEntryPrice: '50000', heldQuantity: '0.5', ...blockerFor(field) });
    const out = trailingTradePositionAdapter.applyFill(held, { kind: 'empty' });
    expect(out?.[field]).toBeNull();
  });

  it.each(SCOPED_FIELDS)(
    'still writes on an empty fill when a flat body is stranded carrying %s',
    (field) => {
      // The already-flat skip below tests the position fields; a stranded body passes every one of them, so a clear behind that guard never runs on the one shape it exists to reach.
      const stranded = base({
        avgEntryPrice: null,
        heldQuantity: null,
        highSinceBuy: null,
        ...blockerFor(field),
      });
      const out = trailingTradePositionAdapter.applyFill(stranded, { kind: 'empty' });
      expect(out).not.toBeNull();
      expect(out?.[field]).toBeNull();
    },
  );

  it('clears every position-scoped blocker when a basis clear leaves no coins behind', () => {
    const flat = base({ avgEntryPrice: '50000', heldQuantity: null, ...allBlockersSet() });
    const out = trailingTradePositionAdapter.clearPosition(flat);
    for (const field of SCOPED_FIELDS) expect(out?.[field]).toBeNull();
  });

  it('keeps every position-scoped blocker when the cleared basis still has coins behind it', () => {
    // `clearPosition` forgets the cost basis and deliberately keeps `heldQuantity` — the wallet reconciler owns that. The coins are still held and still unguarded, so the refusal describes a live exposure and dropping it would delete the operator's only in-state warning.
    const stillHeld = base({ avgEntryPrice: '50000', heldQuantity: '0.5', ...allBlockersSet() });
    const out = trailingTradePositionAdapter.clearPosition(stillHeld);
    for (const field of SCOPED_FIELDS) expect(out?.[field]).not.toBeNull();
  });

  it('keeps every position-scoped blocker when the held quantity is unreadable', () => {
    // Malformed reads as "cannot tell whether coins are held", and the only safe answer to that is to keep the warning: a stale hazard is visible and self-corrects, a deleted one is neither.
    const malformed = base({
      avgEntryPrice: '50000',
      heldQuantity: 0.5 as never,
      ...allBlockersSet(),
    });
    const out = trailingTradePositionAdapter.clearPosition(malformed);
    for (const field of SCOPED_FIELDS) expect(out?.[field]).not.toBeNull();
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
