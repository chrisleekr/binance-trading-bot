import { describe, expect, it } from 'vitest';

import { initialTTState, type TTState } from '../src/schema.js';
import { mergeTTLatchFields } from '../src/merge-concurrent.js';

/**
 * `mergeTTLatchFields` reconciles a tick commit that lost a cross-pod CAS race:
 * it grafts the tick's exit-latch fields onto the winning fill's body. Position
 * and order state must come from `base` (the fill); only the latch anchors come
 * from `latchSource`, taking the more-recent value so a cooldown never moves
 * earlier.
 */
describe('mergeTTLatchFields', () => {
  const state = (over: Partial<TTState>): TTState => ({ ...initialTTState(), ...over });

  it('grafts freshly-stamped latches from the tick onto a winner that has none', () => {
    const base = state({ avgEntryPrice: '100', heldQuantity: '2' });
    const latchSource = state({
      avgEntryPrice: '999', // must NOT win — position belongs to the fill
      lastLossExitAt: 1_000,
      lastLossExitReason: 'grid-stop-loss',
      forceSellCooldownUntilMs: 2_000,
      autoTriggerBuyAtMs: 3_000,
    });

    const merged = mergeTTLatchFields({ base, latchSource });

    // Position/order state stays the winner's.
    expect(merged.avgEntryPrice).toBe('100');
    expect(merged.heldQuantity).toBe('2');
    // Latch fields adopt the tick's stamps.
    expect(merged.lastLossExitAt).toBe(1_000);
    expect(merged.lastLossExitReason).toBe('grid-stop-loss');
    expect(merged.forceSellCooldownUntilMs).toBe(2_000);
    expect(merged.autoTriggerBuyAtMs).toBe(3_000);
  });

  it('keeps the winner latch when it is the more-recent, ignoring a null tick side', () => {
    const base = state({
      lastLossExitAt: 5_000,
      lastLossExitReason: 'old',
      forceSellCooldownUntilMs: 9_000,
      autoTriggerBuyAtMs: 4_000, // tick side stays null -> winner's value is kept
    });
    const latchSource = state({
      lastLossExitAt: 1_000,
      lastLossExitReason: 'new',
      forceSellCooldownUntilMs: 2_000,
    });

    const merged = mergeTTLatchFields({ base, latchSource });

    // Later anchor wins (never move a cooldown earlier); reason follows it.
    expect(merged.lastLossExitAt).toBe(5_000);
    expect(merged.lastLossExitReason).toBe('old');
    expect(merged.forceSellCooldownUntilMs).toBe(9_000);
    // Winner's re-arm survives a null tick side.
    expect(merged.autoTriggerBuyAtMs).toBe(4_000);
  });

  it('takes the later cooldown when the tick side exceeds the winner', () => {
    const merged = mergeTTLatchFields({
      base: state({ forceSellCooldownUntilMs: 2_000 }),
      latchSource: state({ forceSellCooldownUntilMs: 5_000 }),
    });
    expect(merged.forceSellCooldownUntilMs).toBe(5_000);
  });

  it('prefers the tick reason when both anchors share a millisecond', () => {
    const base = state({ lastLossExitAt: 1_000, lastLossExitReason: 'base' });
    const latchSource = state({ lastLossExitAt: 1_000, lastLossExitReason: 'tick' });

    const merged = mergeTTLatchFields({ base, latchSource });

    expect(merged.lastLossExitAt).toBe(1_000);
    expect(merged.lastLossExitReason).toBe('tick');
  });

  it('leaves latches null and the reason null when neither side stamped one', () => {
    const merged = mergeTTLatchFields({ base: state({}), latchSource: state({}) });

    expect(merged.lastLossExitAt).toBeNull();
    expect(merged.lastLossExitReason).toBeNull();
    expect(merged.forceSellCooldownUntilMs).toBeNull();
    expect(merged.autoTriggerBuyAtMs).toBeNull();
  });

  it('does not mutate either input', () => {
    const base = state({ lastLossExitAt: 5_000 });
    const latchSource = state({ lastLossExitAt: 1_000 });
    mergeTTLatchFields({ base, latchSource });
    expect(base.lastLossExitAt).toBe(5_000);
    expect(latchSource.lastLossExitAt).toBe(1_000);
  });
});
