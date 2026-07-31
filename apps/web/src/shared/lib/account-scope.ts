import { useSyncExternalStore } from 'react';

import { encodePathSegment } from '@/shared/lib/api';

// Active account is URL-driven: the `/accounts/$accountId` route's beforeLoad
// sets it before any loader or API call under that route runs. A module store
// (not React state) so the non-React api functions can read it when building a
// request path. localStorage holds only the redirect default for a bare `/`
// visit — the URL is the source of truth, this mirrors it.

const KEY = 'active-account';

const readStored = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

let current: string | null = readStored();
const listeners = new Set<() => void>();

/**
 * Set the active account from anywhere, including outside React (a route
 * `beforeLoad`). Persists as the `/` redirect default and notifies subscribers.
 * A no-op when unchanged.
 */
export const setActiveAccountId = (accountId: string): void => {
  if (accountId === current) return;
  current = accountId;
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(KEY, accountId);
  } catch {
    // Private-mode storage failure only loses the redirect default, not function.
  }
  for (const listener of listeners) listener();
};

/** The last account the operator viewed, to redirect a bare `/` visit. */
export const lastActiveAccountId = (): string | null => readStored();

export const useActiveAccountId = (): string | null =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );

/**
 * Build an account-scoped API path. Every account-scoped router mounts under
 * `/api/accounts/:accountId`, so callers keep writing the account-relative
 * subpath (`/profiles/x`, `/api-key`) and this prefixes the active account.
 * Throws when no account is active — an account-scoped call off an account route
 * is a bug, never a silent wrong-account request.
 */
export const accountPath = (subpath: string): string => {
  if (current === null) {
    throw new Error(`accountPath called with no active account: ${subpath}`);
  }
  const rel = subpath.startsWith('/') ? subpath : `/${subpath}`;
  return `/accounts/${encodePathSegment(current)}${rel}`;
};
