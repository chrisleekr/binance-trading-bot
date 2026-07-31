// seedNextRow — the AutoForm "Add" affordance clones the last array row in full
// so the operator edits a delta (e.g. a grid level keeps the prior level's
// trigger/stop/limit/min/max) instead of starting blank.

import { describe, expect, it } from 'vitest';

import { seedNextRow } from '../src/shared/forms/field-renderer.js';

describe('seedNextRow', () => {
  it('clones the last row in full, including its trigger', () => {
    const rows = [
      { triggerPercentage: '1', maxPurchaseAmount: '15' },
      { triggerPercentage: '0.97', maxPurchaseAmount: '12' },
    ];
    expect(seedNextRow(rows)).toEqual({ triggerPercentage: '0.97', maxPurchaseAmount: '12' });
  });

  it('returns a clone, not the same reference, leaving the source untouched', () => {
    const rows = [{ triggerPercentage: '0.97', maxPurchaseAmount: '12' }];
    const seeded = seedNextRow(rows) as Record<string, unknown>;
    expect(seeded).not.toBe(rows[0]);
    seeded['maxPurchaseAmount'] = '99';
    expect(rows[0]?.maxPurchaseAmount).toBe('12');
  });

  it('returns undefined for an empty array (RHF empty-row append)', () => {
    expect(seedNextRow([])).toBeUndefined();
  });

  it('returns undefined when the value is not an array', () => {
    expect(seedNextRow(undefined)).toBeUndefined();
    expect(seedNextRow(null)).toBeUndefined();
  });
});
