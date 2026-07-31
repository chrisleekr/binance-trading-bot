import { describe, expect, it } from 'vitest';

import { initialState, reducer, type WizardState } from '@/features/profile/wizard/reducer';

const strategy: NonNullable<WizardState['strategy']> = {
  name: 'trailing-trade',
  version: '1.0.0',
  displayName: 'Trailing Trade',
  defaultConfig: { a: 1 },
  configSchema: {},
};

describe('wizard reducer', () => {
  it('set-name stores the name', () => {
    const next = reducer(initialState, {
      type: 'set-name',
      name: 'Acme',
    });
    expect(next.name).toBe('Acme');
  });

  it('set-strategy stores the picked strategy', () => {
    const next = reducer(initialState, { type: 'set-strategy', strategy });
    expect(next.strategy).toEqual(strategy);
  });

  it('goto changes step and clears the error', () => {
    const errored: WizardState = { ...initialState, error: 'boom' };
    const next = reducer(errored, { type: 'goto', step: 2 });
    expect(next.step).toBe(2);
    expect(next.error).toBeNull();
  });
});
