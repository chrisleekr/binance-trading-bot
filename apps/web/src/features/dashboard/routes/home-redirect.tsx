// `/` — bare-root redirect to the default account's dashboard. The dashboard
// itself now lives at `/accounts/$accountId`; the operator lands here on the
// last account they viewed, or the first account if that is unknown/stale. With
// no accounts (a fresh operator mid-onboarding) it redirects to the create-
// account flow. The onboarding/login gate in `rootRoute.beforeLoad` runs first.

import { createRoute, redirect } from '@tanstack/react-router';

import { accountsQueryOptions } from '@/features/account/api/accounts';
import { lastActiveAccountId } from '@/shared/lib/account-scope';
import { rootRoute } from '@/app/__root';

export const homeRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: async ({ context }) => {
    const accounts = await context.queryClient.ensureQueryData(accountsQueryOptions);
    if (accounts.length === 0) throw redirect({ to: '/accounts/new' });
    const last = lastActiveAccountId();
    const target = accounts.find((a) => a.id === last) ?? accounts[0]!;
    throw redirect({
      to: '/accounts/$accountId',
      params: { accountId: target.id },
    });
  },
});
