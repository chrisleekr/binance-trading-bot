// /accounts/$accountId — the account scope layer. Every account-scoped surface
// (the dashboard, profiles, api-key, dust-transfer, orphan-orders) nests under
// it, so the account is always named in the URL. `beforeLoad` sets the module
// active-account before any child loader or API call runs, and validates the id
// against the operator's account list so a bad/foreign id renders the not-found
// tree instead of firing account-scoped requests that would 404 piecemeal.

import { createRoute, notFound, Outlet } from '@tanstack/react-router';
import { type ReactNode } from 'react';

import { accountsQueryOptions } from '@/features/account/api/accounts';
import { setActiveAccountId } from '@/shared/lib/account-scope';
import { rootRoute } from '@/app/__root';

function AccountScopeLayout(): ReactNode {
  return <Outlet />;
}

export const accountScopeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts/$accountId',
  beforeLoad: async ({ context, params }) => {
    const accounts = await context.queryClient.ensureQueryData(accountsQueryOptions);
    if (!accounts.some((a) => a.id === params.accountId)) throw notFound();
    // Set only after ownership is confirmed: a child's `accountPath` must never
    // build a request for an account the operator does not own.
    setActiveAccountId(params.accountId);
  },
  component: AccountScopeLayout,
});
