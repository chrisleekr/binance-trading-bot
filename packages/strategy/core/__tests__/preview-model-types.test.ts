import { describe, expect, it } from 'vitest';
import type { PreviewModel, PreviewRow, PreviewTone } from '../src/contract.js';

// Type-lock for the preview model the contract now declares. Runtime-trivial;
// its real work is at compile time (the type annotations below must hold).
describe('preview model types', () => {
  it('PreviewTone includes the trailing-stop tone', () => {
    const trail: PreviewTone = 'trail';
    expect(trail).toBe('trail');
  });

  it('PreviewRow allows a bare row and a priced, triggered row', () => {
    const bare: PreviewRow = { code: 'trend', tone: 'neutral' };
    const priced: PreviewRow = {
      code: 'entry',
      tone: 'entry',
      price: '100',
      triggerWhen: 'above',
      trigger: true,
    };
    expect(bare.price).toBeUndefined();
    expect(priced.triggerWhen).toBe('above');
  });

  it('PreviewModel is titled sections of rows', () => {
    const model: PreviewModel = {
      sections: [{ title: 'Entry', rows: [{ code: 'x', tone: 'buy' }] }],
    };
    expect(model.sections[0]?.rows[0]?.code).toBe('x');
  });
});
