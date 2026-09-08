import { describe, expect, it } from 'vitest';
import { PROTECTIVE_STOP_UNPLACED_CODE } from '@app/contracts';
import { PROTECTIVE_STOP_BLOCKER_REASONS } from '@app/strategy-core';
import type { ReasonKind } from '@app/strategy-core';
import { momentumReasonAttribution } from '../src/attribution.js';
import { ENTRY_SIZING_SKIPS } from '../src/sizing.js';
import { MOMENTUM_EXIT_BLOCKER_REASONS } from '../src/schema.js';

// Momentum owns the reason-code -> gloss/kind map so the web names the levers off
// the strategy's own declaration (invariant #1), never a hardcoded web copy. Every
// entry-suppression reason the pure tick can emit must have a legible entry here.
const ENTRY_REASON_CODES = [
  'already-entered-this-candle',
  'insufficient-history',
  'below-trend',
  'falling-trend',
  ...ENTRY_SIZING_SKIPS,
  'min-qty',
  'min-notional',
  'entry-below-stop-notional',
  'invalid-filters',
  'overextended',
  'extension-insufficient-history',
] as const;

// The list above spreads the sizing skips from `sizing.ts` rather than restating them, and the list below takes the protective-stop reasons from the core vocabulary the same way. Both are derived, not copied, so a reason added at either source fails here until it is glossed instead of reaching the operator as a bare kebab code.
//
// The protective-stop half is not an entry suppression at all: it names an OPEN
// position whose stop the strategy refused to place or re-price. They ride the
// same reason-code map because they gloss the same way, and the tick emits each
// as a `momentum.skip`.
const REASON_CODES = [
  ...ENTRY_REASON_CODES,
  ...PROTECTIVE_STOP_BLOCKER_REASONS,
  ...MOMENTUM_EXIT_BLOCKER_REASONS,
] as const;

const KINDS: readonly ReasonKind[] = ['market', 'config', 'sizing', 'data'];

describe('momentumReasonAttribution', () => {
  it('covers every suppression and protective-stop reason code', () => {
    for (const code of REASON_CODES) {
      expect(momentumReasonAttribution[code], code).toBeDefined();
    }
  });

  it('gives every entry a plain-language gloss and a valid kind', () => {
    for (const code of REASON_CODES) {
      const entry = momentumReasonAttribution[code];
      expect(entry?.gloss, code).toBeDefined();
      expect(KINDS, code).toContain(entry?.kind);
    }
  });

  it('still emits the reason string the platform gates an unguarded position on', () => {
    // This assertion lives HERE, not in the platform package, because it has to fail at the site where the mistake is made. Two consumers outside this package gate on this exact string — the diagnosis persistence tier that promotes it to a finding, and the worker alert that pages the operator once it has lasted — and neither can see a rename in this file. Rename the reason without updating the shared constant and both gates match nothing: no type error, no failure in this package, and an alert about a position with nothing under it that simply stops arriving, which is the single failure the whole feature exists to prevent.
    //
    // The direction of the dependency is deliberate. The strategy asserts it still satisfies a contract the platform holds; the platform never reaches into a strategy.
    expect(MOMENTUM_EXIT_BLOCKER_REASONS).toContain(PROTECTIVE_STOP_UNPLACED_CODE);
    expect(momentumReasonAttribution[PROTECTIVE_STOP_UNPLACED_CODE]).toBeDefined();
  });

  it('does not tell the operator the unplaced stop is nothing', () => {
    // The same note serves two opposite readings: the symbol screen a second after an entry, where this state is expected, and a diagnosis finding raised precisely because it has lasted, where the position has been sitting unguarded the whole time. A note that says the state does not indicate a problem is true only of the first, and reads as an instruction to ignore the second.
    const note = momentumReasonAttribution['protective-stop-unplaced']?.note ?? '';

    expect(note).not.toMatch(/does not by itself indicate a problem/);
    // What replaces it has to survive both readings: the brief expected window, then the consequence and what to look at once it has outlasted it.
    expect(note).toMatch(/Expected for a moment/);
    expect(note).toMatch(/nothing on Binance would sell this position/);
    expect(note).toMatch(/another order is holding the coins/);
  });

  it('tints each reason by the lever the operator can (or cannot) touch', () => {
    // A market read the operator must not relax.
    expect(momentumReasonAttribution['below-trend']?.kind).toBe('market');
    // A config lever: the reserve cap.
    expect(momentumReasonAttribution['cap-reached']?.kind).toBe('config');
    // An order-size problem: the entry budget.
    expect(momentumReasonAttribution['sizing-unconfigured']?.kind).toBe('sizing');
    // A warm-up / data condition that clears over a longer window.
    expect(momentumReasonAttribution['insufficient-history']?.kind).toBe('data');
  });
});
