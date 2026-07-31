// /accounts/$accountId/profiles/$profileId — the per-profile dashboard. Renders
// the shared overview focused on this profile; the LAYOUT route is a bare Outlet
// so the routed children (config, backtest, notifications, history, symbols)
// keep rendering their own chrome. The profile detail is URL-addressed, so the
// account+profile is always named in the request.

import { createRoute, Outlet } from '@tanstack/react-router';
import { type ReactNode } from 'react';

import { DashboardOverview } from '@/features/dashboard/routes/index';
import { accountScopeRoute } from '@/features/account/routes/account-scope';

function ProfileDetailLayout(): ReactNode {
  return <Outlet />;
}

export const profileDetailRoute = createRoute({
  staticData: { title: 'Profile' },
  getParentRoute: () => accountScopeRoute,
  path: '/profiles/$profileId',
  component: ProfileDetailLayout,
});

function ProfileOverviewPage(): ReactNode {
  const { profileId } = profileDetailIndexRoute.useParams();
  return <DashboardOverview focusedProfileId={profileId} />;
}

export const profileDetailIndexRoute = createRoute({
  getParentRoute: () => profileDetailRoute,
  path: '/',
  component: ProfileOverviewPage,
});
