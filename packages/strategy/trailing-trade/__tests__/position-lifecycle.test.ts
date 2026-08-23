// Anti-drift guards for the TT position-lifecycle field set. These pin three
// invariants the six reset sites depended on by hand before #446:
//   1. the clear helpers produce byte-identical objects to the literals they
//      replaced (so the golden replay stays diff-0),
//   2. the schema key set equals POSITION_LIFECYCLE_KEYS ∪ {schemaVersion,
//      triggers} (so a new state field cannot skip the lifecycle list), and
//   3. normalizeTickState coerces every POSITION_LIFECYCLE_KEY (so a new field
//      cannot slip past the `=== null` guards as `undefined`).
// Adding a state field while skipping a site fails one of these, not production.

import { describe, expect, it } from 'vitest';

import { POSITION_SCOPED_STATE_FIELDS } from '@app/strategy-core';
import {
  clearedAddTracking,
  clearedSellPosition,
  POSITION_LIFECYCLE_KEYS,
} from '../src/position-lifecycle.js';
import { TTStateSchema, initialTTState, type TTState } from '../src/schema.js';
import { normalizeTickState } from '../src/tick.js';

describe('position-scoped vocabulary parity', () => {
  // The core list and this package's lifecycle helpers are two hand-maintained enumerations of the same rule. Nothing in the type system ties them, so a field added to one and not the other means the position adapters clear it while the three in-tick sell sites do not — the split-brain this file's other guards exist to prevent, one layer up.
  const scopedInTT = POSITION_SCOPED_STATE_FIELDS.filter((f) => f in TTStateSchema.shape);

  it('pins which core fields TT carries, so a typo in either list fails here', () => {
    expect(scopedInTT).toEqual(['protectiveStopBlocker', 'exitBlocker']);
  });

  it.each(scopedInTT)('clearedSellPosition nulls %s', (field) => {
    expect(clearedSellPosition(null)[field]).toBeNull();
  });

  it.each(scopedInTT)('POSITION_LIFECYCLE_KEYS contains %s', (field) => {
    expect(POSITION_LIFECYCLE_KEYS).toContain(field);
  });
});

describe('clearedAddTracking', () => {
  it('produces exactly the bull-pyramid + discovery reset fields', () => {
    expect(clearedAddTracking()).toEqual({
      bullAddCount: null,
      lastBullAddPrice: null,
      discoveryEntry: false,
      entryAtMs: null,
    });
  });

  it('returns a fresh object each call (no shared aliasing across reset sites)', () => {
    expect(clearedAddTracking()).not.toBe(clearedAddTracking());
  });
});

describe('clearedSellPosition', () => {
  // The literal every sell-side full-exit site reset before #446, parameterised
  // only by autoTriggerBuyAtMs. heldQuantity is intentionally absent (the
  // fill-adopter owns it).
  const expectedSellReset = (autoTriggerBuyAtMs: number | null) => ({
    avgEntryPrice: null,
    highSinceBuy: null,
    breakEvenArmed: false,
    currentGridTradeIndex: null,
    bullAddCount: null,
    lastBullAddPrice: null,
    discoveryEntry: false,
    entryAtMs: null,
    autoTriggerBuyAtMs,
    // The confirm-window tracker and the technicals-hysteresis streak reset on a
    // full close; the re-entry cooldowns (forceSellCooldownUntilMs, lastLossExitAt
    // / lastLossExitReason) deliberately survive, so they are absent here.
    forceSellFirstSeenAtMs: null,
    entryConfirmCount: 0,
    // The stop-arm blocker is position-scoped: a closed position has nothing left
    // to protect, so the "unprotected" warning must not outlive it.
    protectiveStopBlocker: null,
    // Same scoping for the exit blocker: "why didn't it sell" is meaningless once
    // there is nothing held, and a stale reason would misreport the next entry.
    exitBlocker: null,
  });

  it('matches the armed sell-reset literal byte-for-byte (timed exit)', () => {
    expect(clearedSellPosition(1_700_000_123_456)).toEqual(expectedSellReset(1_700_000_123_456));
  });

  it('matches the unarmed sell-reset literal byte-for-byte (regime exit)', () => {
    expect(clearedSellPosition(null)).toEqual(expectedSellReset(null));
  });

  it('never carries heldQuantity (the fill-adopter owns that transition)', () => {
    expect(Object.keys(clearedSellPosition(null))).not.toContain('heldQuantity');
  });
});

describe('position-lifecycle key parity', () => {
  it('TTStateSchema keys equal POSITION_LIFECYCLE_KEYS plus schemaVersion + triggers', () => {
    // A new state field added to the schema but not routed through the lifecycle
    // list fails here — which in turn forces the normalize-coverage test below.
    expect(new Set(Object.keys(TTStateSchema.shape))).toEqual(
      new Set([...POSITION_LIFECYCLE_KEYS, 'schemaVersion', 'triggers']),
    );
  });

  it('normalizeTickState coerces every position-lifecycle key away from undefined', () => {
    for (const key of POSITION_LIFECYCLE_KEYS) {
      // Seed a valid state, then blank one position key as an at-version row that
      // omitted it would load. normalize must coerce it to its contract default.
      const raw = { ...initialTTState(), [key]: undefined } as unknown as TTState;
      expect(normalizeTickState(raw)[key]).not.toBeUndefined();
    }
  });
});

describe('initialTTState', () => {
  it('is the schema-derived seed (every default applied, no undefined)', () => {
    const seed = initialTTState();
    expect(seed).toEqual(TTStateSchema.parse({ schemaVersion: '2.0.0' }));
    for (const value of Object.values(seed)) expect(value).not.toBeUndefined();
  });

  it('yields a fresh triggers envelope per call (no shared default alias)', () => {
    expect(initialTTState().triggers).not.toBe(initialTTState().triggers);
  });
});
