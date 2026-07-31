// planUnauthorizedRedirect — the decision behind the global 401 handler. The
// load-bearing behaviour is the recursion guard (no redirect when already on
// /login, which would nest /login into `from` and stack history) and the
// redirect shape (carry `from`, stamp reason=expired, replace not push).

import { describe, expect, it } from 'vitest';

import { planUnauthorizedRedirect } from '@/app/unauthorized-redirect';

describe('planUnauthorizedRedirect', () => {
  it('redirects to /login carrying the current URL, stamped expired, replacing history', () => {
    expect(planUnauthorizedRedirect('/account', '/account')).toEqual({
      to: '/login',
      search: { from: '/account', reason: 'expired' },
      replace: true,
    });
  });

  it('preserves the full return URL (path + query) in `from`', () => {
    const plan = planUnauthorizedRedirect('/profiles/abc', '/profiles/abc?tab=trade');
    expect(plan?.search.from).toBe('/profiles/abc?tab=trade');
  });

  it('is a no-op when already on /login — no recursive from= / history trap', () => {
    // A 401 fired by the sign-in attempt itself must NOT re-navigate to /login;
    // that would capture /login into `from` and stack a junk Back entry.
    expect(planUnauthorizedRedirect('/login', '/login')).toBeNull();
  });

  it('always replaces rather than pushes, so an expired session adds no Back entry', () => {
    expect(planUnauthorizedRedirect('/', '/')?.replace).toBe(true);
  });
});
