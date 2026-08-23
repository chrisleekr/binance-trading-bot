import { afterEach, describe, expect, it } from 'vitest';
import {
  POSITION_SCOPED_STATE_FIELDS,
  clearPositionScopedFields,
  hasPositionScopedFieldSet,
} from '../src/position-scope.js';

describe('position-scoped state fields', () => {
  it('does not claim entryBlocker, which is scoped to a FLAT profile', () => {
    // Stated so the opposite-scoped field can never be folded in by someone pattern-matching on the name: clearing it when flat would erase the very reason the profile is not buying.
    expect(POSITION_SCOPED_STATE_FIELDS).not.toContain('entryBlocker');
  });

  it.each(POSITION_SCOPED_STATE_FIELDS)('clears %s when the body carries it', (field) => {
    const cleared = clearPositionScopedFields({ [field]: { reason: 'whatever' } });
    expect(cleared[field]).toBeNull();
  });

  it('leaves a field the body does not carry absent rather than materialising it as null', () => {
    // Momentum has no `exitBlocker`. Writing one would put a key on its body that neither its schema nor its replay fixtures have ever seen.
    const cleared = clearPositionScopedFields({ protectiveStopBlocker: { reason: 'x' } });
    expect('exitBlocker' in cleared).toBe(false);
  });

  it('returns the same reference when there is nothing to clear', () => {
    const state = { protectiveStopBlocker: null, entryPrice: null };
    expect(clearPositionScopedFields(state)).toBe(state);
  });

  it('never mutates its input', () => {
    const state = { protectiveStopBlocker: { reason: 'x' } };
    clearPositionScopedFields(state);
    expect(state.protectiveStopBlocker).not.toBeNull();
  });

  it.each(POSITION_SCOPED_STATE_FIELDS)('hasPositionScopedFieldSet sees %s', (field) => {
    expect(hasPositionScopedFieldSet({ [field]: { reason: 'x' } })).toBe(true);
    expect(hasPositionScopedFieldSet({ [field]: null })).toBe(false);
  });

  it('hasPositionScopedFieldSet is false for a body carrying none of them', () => {
    expect(hasPositionScopedFieldSet({ entryPrice: null, entryBlocker: { reason: 'x' } })).toBe(
      false,
    );
  });

  it.each(POSITION_SCOPED_STATE_FIELDS)('reads an undefined-valued %s as unset', (field) => {
    // The adapter guard this extends spells the same rule: `=== null || === undefined`. Reading an explicit undefined as SET would defeat the already-flat short-circuit and rewrite the row on every empty fill, which is the churn that guard exists to prevent.
    expect(hasPositionScopedFieldSet({ [field]: undefined })).toBe(false);
  });

  describe('under a polluted Object.prototype', () => {
    // Defined rather than assigned, so the planted key is non-enumerable: prototype lookup and `Object.hasOwn` behave identically either way, but an enumerable one would surface in every `for…in` in the process for the life of the test.
    const pollute = (value: unknown): void => {
      Object.defineProperty(Object.prototype, 'exitBlocker', { value, configurable: true });
    };

    afterEach(() => {
      delete (Object.prototype as Record<string, unknown>)['exitBlocker'];
    });

    it('does not report an inherited field as set', () => {
      pollute({ reason: 'inherited' });
      expect(hasPositionScopedFieldSet({ protectiveStopBlocker: null })).toBe(false);
    });

    it('does not materialise an inherited field onto a body that lacks it', () => {
      pollute({ reason: 'inherited' });
      const cleared = clearPositionScopedFields({ protectiveStopBlocker: { reason: 'x' } });
      expect(Object.hasOwn(cleared, 'exitBlocker')).toBe(false);
    });
  });
});
