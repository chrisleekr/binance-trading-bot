import { useQuery } from '@tanstack/react-query';
import { useLocation } from '@tanstack/react-router';
import { createContext, useContext, type ReactNode } from 'react';

import { accountSettingsQueryOptions } from '@/features/account/api/account-settings';

// Operator-configured display timezone, fetched once and shared so every
// timestamp on the screen renders in the same zone. Defaults to 'UTC' while the
// query is loading or when consumed outside the provider (e.g. an isolated unit
// test render) so callers never have to guard for absence.

const TimezoneContext = createContext<string>('UTC');

const PUBLIC_PATHS = new Set<string>(['/login', '/onboarding']);

export function TimezoneProvider({ children }: { children: ReactNode }): ReactNode {
  // The settings endpoint requires a session; skip it on the public auth pages
  // so a signed-out visitor does not trigger a 401.
  const { pathname } = useLocation();
  const enabled = !PUBLIC_PATHS.has(pathname);
  const { data } = useQuery({ ...accountSettingsQueryOptions, enabled });
  return (
    <TimezoneContext.Provider value={data?.timezone ?? 'UTC'}>{children}</TimezoneContext.Provider>
  );
}

/** The operator's configured display timezone, or 'UTC' while loading/absent. */
export function useTimezone(): string {
  return useContext(TimezoneContext);
}
