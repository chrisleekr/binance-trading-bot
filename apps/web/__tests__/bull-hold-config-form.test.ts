// The profile config form is auto-generated from the TT config schema via the
// SPA's JSON-Schema render path. These assertions pin that
// `regime.onBull.hold.{enabled,room}` surfaces with plain-language copy and —
// the invariant-#3 promise — never exposes the word "ATR" to the operator (the
// volatility math is an engine-internal room→multiplier map).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildFormFieldsFromJsonSchema, type FormField } from '@app/contracts';
import { TTConfigSchema } from '@app/strategy-trailing-trade';

const flatten = (fields: readonly FormField[]): FormField[] =>
  fields.flatMap((f) => (f.kind === 'object' ? [f, ...flatten(f.fields)] : [f]));

// Convert exactly as the API registry does (`io: 'input'`), the JSON Schema the SPA receives.
const fields = flatten(
  buildFormFieldsFromJsonSchema(
    z.toJSONSchema(TTConfigSchema, { unrepresentable: 'any', io: 'input' }),
  ),
);
const byPath = (path: string): FormField | undefined => fields.find((f) => f.path === path);

describe('bull-hold config form fields', () => {
  it('renders regime.onBull.hold.enabled as a plain on/off toggle', () => {
    const f = byPath('regime.onBull.hold.enabled');
    expect(f?.kind).toBe('boolean');
    expect(f?.description).toMatch(/more room/i);
    expect(f?.description ?? '').not.toMatch(/atr/i);
  });

  it('renders regime.onBull.hold.room as a tight/normal/loose choice', () => {
    const f = byPath('regime.onBull.hold.room');
    expect(f?.kind).toBe('enum');
    if (f?.kind !== 'enum') throw new Error('expected enum');
    expect([...f.options]).toEqual(['tight', 'normal', 'loose']);
    expect(f.description).toMatch(/looser rides bigger swings/i);
    expect(f.description ?? '').not.toMatch(/atr/i);
  });
});

describe('bull-pyramid config form fields', () => {
  it('renders the four pyramid knobs from the schema', () => {
    expect(byPath('regime.onBull.pyramid.enabled')?.kind).toBe('boolean');

    const step = byPath('regime.onBull.pyramid.stepPercentage');
    expect(step?.kind).toBe('string');
    expect(step?.description).toMatch(/5 percent up/i);

    const maxAdds = byPath('regime.onBull.pyramid.maxAdds');
    expect(maxAdds?.kind).toBe('number');
    if (maxAdds?.kind !== 'number') throw new Error('expected number');
    expect(maxAdds.minimum).toBe(1);
    expect(maxAdds.maximum).toBe(20);

    const budget = byPath('regime.onBull.pyramid.maxPurchaseAmount');
    expect(budget?.kind).toBe('string');
    expect(budget?.widget).toBe('price');
  });
});
