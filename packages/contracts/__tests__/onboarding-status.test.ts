// Criterion 5 (contract): OnboardingStatus carries a demoMode flag that drives
// the SPA's persistent Live-demo banner. It defaults to false so a client /
// fixture predating the field keeps today's behaviour.
//
// RED: OnboardingStatus has no demoMode field, so zod strips it — the default
// is absent and an explicit value is dropped.

import { describe, expect, it } from 'vitest';

import { OnboardingStatus } from '../src/auth.js';

describe('OnboardingStatus.demoMode', () => {
  it('defaults demoMode to false when the field is absent', () => {
    expect(OnboardingStatus.parse({ masterExists: true })).toEqual({
      masterExists: true,
      demoMode: false,
    });
  });

  it('accepts an explicit demoMode: true', () => {
    expect(OnboardingStatus.parse({ masterExists: true, demoMode: true }).demoMode).toBe(true);
  });
});
