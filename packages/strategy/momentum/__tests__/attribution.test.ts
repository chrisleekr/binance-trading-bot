import { describe, expect, it } from 'vitest';
import type { ReasonKind } from '@app/strategy-core';
import { momentumReasonAttribution } from '../src/attribution.js';

// Momentum owns the reason-code -> gloss/kind map so the web names the levers off
// the strategy's own declaration (invariant #1), never a hardcoded web copy. Every
// entry-suppression reason the pure tick can emit must have a legible entry here.
const REASON_CODES = [
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
  // Not an entry suppression: an OPEN position whose protective stop the strategy
  // refused to place. It rides the same reason-code map because it is glossed the
  // same way, and the tick emits it as a `momentum.skip` with this reason.
  'base-locked-by-foreign-order',
] as const;

const KINDS: readonly ReasonKind[] = ['market', 'config', 'sizing', 'data'];

describe('momentumReasonAttribution', () => {
  it('covers every one of the twelve suppression reason codes', () => {
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
