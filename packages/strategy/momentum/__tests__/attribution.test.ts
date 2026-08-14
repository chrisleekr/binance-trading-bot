import { describe, expect, it } from 'vitest';
import { PROTECTIVE_STOP_BLOCKER_REASONS } from '@app/strategy-core';
import type { ReasonKind } from '@app/strategy-core';
import { momentumReasonAttribution } from '../src/attribution.js';

// Momentum owns the reason-code -> gloss/kind map so the web names the levers off
// the strategy's own declaration (invariant #1), never a hardcoded web copy. Every
// entry-suppression reason the pure tick can emit must have a legible entry here.
const ENTRY_REASON_CODES = [
  'already-entered-this-candle',
  'insufficient-history',
  'below-trend',
  'falling-trend',
  'sizing-unconfigured',
  'cap-reached',
  'min-qty',
  'min-notional',
  'invalid-filters',
  'overextended',
  'extension-insufficient-history',
] as const;

// Not entry suppressions: an OPEN position whose protective stop the strategy
// refused to place or re-price. They ride the same reason-code map because they
// gloss the same way, and the tick emits each as a `momentum.skip`. Taken from
// the core vocabulary rather than copied, so a new blocker reason fails here
// until it is glossed instead of reaching the operator as a bare kebab code.
const REASON_CODES = [...ENTRY_REASON_CODES, ...PROTECTIVE_STOP_BLOCKER_REASONS] as const;

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
