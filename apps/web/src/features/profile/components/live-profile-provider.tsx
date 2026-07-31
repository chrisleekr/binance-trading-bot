import { useQuery } from '@tanstack/react-query';
import { useLocation, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, type ReactNode } from 'react';

import {
  ProfileProvider,
  type Profile,
  type ProfileContextValue,
} from '@/features/profile/lib/profile-context';
import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import { useActiveAccountId } from '@/shared/lib/account-scope';

const PUBLIC_PATHS = new Set<string>(['/login', '/onboarding']);

// Last profile route the operator opened. Off-route account pages (e.g. dust
// transfer) target it as a fallback so they never silently act on the wrong
// profile. Kept separate from the Home scope filter — which the operator sets
// explicitly and which defaults to 'all' — so opening a profile page does not
// also re-filter the Home overview.
const LAST_ACTIVE_KEY = 'profile-last-active';

const readLastActive = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LAST_ACTIVE_KEY);
  } catch {
    return null;
  }
};

const writeLastActive = (id: string): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_ACTIVE_KEY, id);
  } catch {
    // Storage disabled; the route still drives the active profile this session.
  }
};

export function LiveProfileProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const accountId = useActiveAccountId() ?? '';
  const enabled = !PUBLIC_PATHS.has(location.pathname) && accountId !== '';
  const { data } = useQuery({ ...dashboardAggregateQueryOptions(accountId), enabled });
  const routeProfileId = useParams({ strict: false }).profileId ?? null;

  // Persist the last profile route once the live list confirms it exists.
  // Re-read every render so the value is current without a shared store.
  useEffect(() => {
    if (routeProfileId && (data?.profiles ?? []).some((p) => p.profileId === routeProfileId)) {
      writeLastActive(routeProfileId);
    }
  }, [routeProfileId, data]);
  const lastActive = readLastActive();

  const value = useMemo<ProfileContextValue>(() => {
    // `enabled: false` does not clear cached data; gate explicitly so a
    // signed-out user on /login or /onboarding never sees stale profiles.
    const rows = enabled ? (data?.profiles ?? []) : [];
    const profiles: Profile[] = rows.map((p) => ({
      id: p.profileId,
      name: p.name,
    }));
    // Resolution order: the current profile route, then an explicit Home scope
    // selection, then the last profile route visited, then the first profile.
    const preferred = routeProfileId ?? lastActive;
    const activeProfileId = enabled
      ? (profiles.find((p) => p.id === preferred)?.id ?? profiles[0]?.id ?? null)
      : null;
    return { profiles, activeProfileId };
  }, [data, enabled, routeProfileId, lastActive]);

  return <ProfileProvider value={value}>{children}</ProfileProvider>;
}
