// Retired route. The trade archive now lives on the profile History page; an
// old `/profiles/$id/archive` bookmark redirects there.

import { createRoute, redirect } from '@tanstack/react-router';

import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';

export const archiveRoute = createRoute({
  staticData: { title: 'Archive' },
  getParentRoute: () => profileDetailRoute,
  path: 'archive',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/accounts/$accountId/profiles/$profileId/history',
      params: { accountId: params.accountId, profileId: params.profileId },
      search: { section: 'archive' },
    });
  },
});
