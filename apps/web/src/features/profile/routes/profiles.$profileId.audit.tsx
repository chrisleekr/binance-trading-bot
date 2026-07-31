// Retired route. The audit log now lives on the profile History page; an old
// `/profiles/$id/audit` bookmark redirects there. The old `?event=` filter is
// dropped — the History page's audit tab keeps its own filter state.

import { createRoute, redirect } from '@tanstack/react-router';

import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';

export const auditRoute = createRoute({
  staticData: { title: 'Audit log' },
  getParentRoute: () => profileDetailRoute,
  path: 'audit',
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/accounts/$accountId/profiles/$profileId/history',
      params: { accountId: params.accountId, profileId: params.profileId },
      search: { section: 'audit' },
    });
  },
});
