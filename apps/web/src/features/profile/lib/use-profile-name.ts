import { useQuery } from '@tanstack/react-query';

import { fetchProfile, profileQueryKey } from '@/features/profile/api/profile';

/**
 * The profile's display name for a page header's meta slot. Reads the same
 * cache key the profile-scoped panels populate, so it is a warm read on a page
 * whose panel has already loaded the profile — no extra round-trip in the
 * common case.
 */
export function useProfileName(profileId: string): string | undefined {
  return useQuery({
    queryKey: profileQueryKey(profileId),
    queryFn: () => fetchProfile(profileId),
  }).data?.name;
}
