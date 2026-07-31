// Operator-facing copy for the two account-level exclusivity dispositions (#661).
// A sibling-blocked candidate must read as a clear "blocked by another profile"
// reason, never a bare status, so a solo operator understands why a coin the
// scan liked was not picked up (invariant #3).

import { describe, expect, it } from 'vitest';
import type { DiscoveryCandidate } from '@app/contracts';
import { DISPOSITION, reasonOf } from '@/features/profile/components/discovery-dashboard';

const candidate = (over: Partial<DiscoveryCandidate>): DiscoveryCandidate =>
  ({
    symbol: 'AAAUSDT',
    gainerScore: '1',
    passed: [],
    failedAt: null,
    disposition: 'added',
    reason: null,
    ...over,
  }) as DiscoveryCandidate;

describe('discovery disposition copy (#661)', () => {
  it('renders a sibling-owns-base block with an operator-visible label and reason', () => {
    expect(DISPOSITION['sibling-owns-base'].label).toBe('another profile');
    expect(reasonOf(candidate({ disposition: 'sibling-owns-base' }))).toBe(
      'blocked — another profile on this account already trades this coin',
    );
  });

  it('renders a sibling-quotes-base block with an operator-visible label and reason', () => {
    expect(DISPOSITION['sibling-quotes-base'].label).toBe('another profile');
    expect(reasonOf(candidate({ disposition: 'sibling-quotes-base' }))).toBe(
      'blocked — another profile on this account uses this coin as its quote currency',
    );
  });
});
