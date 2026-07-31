import { describe, expect, it } from 'vitest';
import { isOverrideKindSupported } from '../../src/tick/override-settlement.js';

/**
 * The belt-and-suspenders guard that catches a stale override for an action the
 * strategy does not declare (the momentum silent-drop's last line of defence).
 * Unit-testing the predicate directly guards against the regression that would
 * otherwise ship green: inverting the condition, or flagging a malformed
 * (kind-less) bundle as a capability mismatch.
 */
describe('isOverrideKindSupported', () => {
  it('accepts an action the strategy declares', () => {
    expect(
      isOverrideKindSupported(['manual-order', 'trigger-buy', 'trigger-sell'], 'trigger-buy'),
    ).toBe(true);
  });

  it('rejects an action the strategy does not declare (momentum)', () => {
    expect(isOverrideKindSupported([], 'trigger-buy')).toBe(false);
    expect(isOverrideKindSupported(['manual-order'], 'trigger-sell')).toBe(false);
  });

  it('treats a kind-less override as supported (malformed/legacy, not a mismatch)', () => {
    expect(isOverrideKindSupported([], undefined)).toBe(true);
    expect(isOverrideKindSupported(['manual-order'], undefined)).toBe(true);
  });
});
