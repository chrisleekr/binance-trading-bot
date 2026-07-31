// `/account` — folded into `/settings`, which is the word an operator looks for
// and no longer collides with a first-class Binance *account* (of which there
// are now many). Kept as a permanent redirect so old bookmarks and the
// service-worker-cached shell still land on a valid route.

import { createRoute, redirect } from '@tanstack/react-router';

import { rootRoute } from '@/app/__root';

export const accountRoute = createRoute({
  staticData: { title: 'Settings' },
  getParentRoute: () => rootRoute,
  path: '/account',
  beforeLoad: () => {
    throw redirect({ to: '/settings' });
  },
});
