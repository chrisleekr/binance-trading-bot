// Pure decision for the global 401 handler (wired in main.tsx). Kept separate
// from the router side effect so the load-bearing part — the recursion guard
// and the redirect shape — is unit-testable without a live router.

/** The login redirect a 401 produces: carry the current URL in `from`, stamp
 *  `reason` so the page explains the bounce, and replace (not push) so an
 *  expired session leaves no Back-button trap. */
export interface LoginRedirect {
  readonly to: '/login';
  readonly search: { readonly from: string; readonly reason: 'expired' };
  readonly replace: true;
}

/**
 * Decide where a 401 should send the operator. Returns null when they are
 * already on `/login` — re-navigating there would nest `/login` into `from` on
 * every hop (a recursive-encoded URL) and stack junk history entries. The 401
 * during a sign-in attempt is the common trigger for that no-op case.
 */
export function planUnauthorizedRedirect(
  currentPathname: string,
  returnTo: string,
): LoginRedirect | null {
  if (currentPathname === '/login') return null;
  return { to: '/login', search: { from: returnTo, reason: 'expired' }, replace: true };
}
