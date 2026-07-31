import { createContext, useContext, useMemo, type ReactNode } from 'react';

/*
 * Profile context for the app shell.
 *
 * 07.01 ships with a stub default (no profiles). 07.05+ wires this to the
 * /dashboard-aggregate query so the shell reflects live state.
 */

export interface Profile {
  readonly id: string;
  readonly name: string;
}

export interface ProfileContextValue {
  readonly profiles: readonly Profile[];
  readonly activeProfileId: string | null;
}

const defaultValue: ProfileContextValue = { profiles: [], activeProfileId: null };

const ProfileContext = createContext<ProfileContextValue>(defaultValue);

export function ProfileProvider({
  value,
  children,
}: {
  value?: ProfileContextValue;
  children: ReactNode;
}): ReactNode {
  const v = useMemo<ProfileContextValue>(() => value ?? defaultValue, [value]);
  return <ProfileContext.Provider value={v}>{children}</ProfileContext.Provider>;
}

export function useProfiles(): ProfileContextValue {
  return useContext(ProfileContext);
}
