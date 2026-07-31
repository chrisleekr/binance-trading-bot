import { describe, expect, it } from 'vitest';

import {
  ONBOARDING_STATUS_QUERY_KEY,
  onboardingStatusQueryOptions,
} from '@/features/auth/api/auth';

describe('onboardingStatusQueryOptions', () => {
  it('uses the canonical query key', () => {
    expect(onboardingStatusQueryOptions.queryKey).toEqual(ONBOARDING_STATUS_QUERY_KEY);
    expect(onboardingStatusQueryOptions.queryKey).toEqual(['auth', 'onboarding-status']);
  });

  it('caches forever (staleTime + gcTime: Infinity)', () => {
    expect(onboardingStatusQueryOptions.staleTime).toBe(Number.POSITIVE_INFINITY);
    expect(onboardingStatusQueryOptions.gcTime).toBe(Number.POSITIVE_INFINITY);
  });

  it('exposes a queryFn', () => {
    expect(typeof onboardingStatusQueryOptions.queryFn).toBe('function');
  });
});
