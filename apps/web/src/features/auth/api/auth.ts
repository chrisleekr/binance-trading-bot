import { OnboardingStatus } from '@app/contracts';
import { useQuery, type QueryClient } from '@tanstack/react-query';

import { apiFetch } from '@/shared/lib/api';

export const ONBOARDING_STATUS_QUERY_KEY = ['auth', 'onboarding-status'] as const;

const fetchOnboardingStatus = (): Promise<OnboardingStatus> =>
  apiFetch('/auth/onboarding-status', OnboardingStatus);

export const onboardingStatusQueryOptions = {
  queryKey: ONBOARDING_STATUS_QUERY_KEY,
  queryFn: fetchOnboardingStatus,
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
} as const;

/**
 * Whether this is a public "Live demo" deployment. Reads the onboarding-status
 * query the root loader already primes (staleTime Infinity), so it never fetches
 * again; absent data reads as false. Drives the demo banner and hidden nav.
 */
export const useDemoMode = (): boolean => {
  const { data } = useQuery(onboardingStatusQueryOptions);
  return data?.demoMode ?? false;
};

// The branching contract for the root loader. Pulled out of the route module
// so it can be unit-tested without spinning a TanStack Router instance.
export const resolveOnboardingRedirect = async (
  queryClient: QueryClient,
  pathname: string,
): Promise<'/login' | '/onboarding' | null> => {
  const status = await queryClient.ensureQueryData(onboardingStatusQueryOptions);
  if (!status.masterExists && pathname !== '/onboarding') return '/onboarding';
  if (status.masterExists && pathname === '/onboarding') return '/login';
  return null;
};
