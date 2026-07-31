import type { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';

import { accountRoute } from '@/features/account/routes/account';
import { accountNewRoute } from '@/features/account/routes/account.new';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { apiKeyRoute } from '@/features/account/routes/account.api-key';
import { backupRestoreRoute } from '@/features/account/routes/settings.backup-restore';
import { dustTransferRoute } from '@/features/account/routes/account.dust-transfer';
import { orphanOrdersRoute } from '@/features/account/routes/account.orphan-orders';
import { accountSettingsRoute } from '@/features/account/routes/account.settings';
import { accountOverviewRoute } from '@/features/dashboard/routes/index';
import { homeRedirectRoute } from '@/features/dashboard/routes/home-redirect';
import { loginRoute } from '@/features/auth/routes/login';
import { onboardingRoute } from '@/features/account/routes/onboarding';
import {
  profileDetailIndexRoute,
  profileDetailRoute,
} from '@/features/profile/routes/profiles.$profileId';
import { archiveRoute } from '@/features/profile/routes/profiles.$profileId.archive';
import { auditRoute } from '@/features/profile/routes/profiles.$profileId.audit';
import { configRoute } from '@/features/profile/routes/profiles.$profileId.config';
import { discoveryRoute } from '@/features/profile/routes/profiles.$profileId.discovery';
import { riskRoute } from '@/features/profile/routes/profiles.$profileId.risk';
import { gateRoute } from '@/features/profile/routes/profiles.$profileId.gate';
import { generalRoute } from '@/features/profile/routes/profiles.$profileId.general';
import { bulkOrderRoute } from '@/features/profile/routes/profiles.$profileId.bulk-order';
import { historyRoute } from '@/features/profile/routes/profiles.$profileId.history';
import { backtestRoute } from '@/features/backtest/routes/profiles.$profileId.backtest';
import { symbolDetailRoute } from '@/features/symbol/routes/profiles.$profileId.symbols.$symbol';
import { symbolConfigRoute } from '@/features/symbol/routes/profiles.$profileId.symbols.$symbol.config';
import { symbolsNewRoute } from '@/features/symbol/routes/profiles.$profileId.symbols.new';
import { profileNewRoute } from '@/features/profile/routes/profiles.new';
import { notificationsRoute } from '@/features/notifications/routes/profiles.notifications';
import { rootRoute } from '@/app/__root';
import { RoutePending } from '@/app/route-pending';
import { settingsRoute } from '@/features/account/routes/settings';

const routeTree = rootRoute.addChildren([
  homeRedirectRoute,
  onboardingRoute,
  loginRoute,
  accountNewRoute,
  accountScopeRoute.addChildren([
    accountOverviewRoute,
    profileNewRoute,
    apiKeyRoute,
    accountSettingsRoute,
    dustTransferRoute,
    orphanOrdersRoute,
    profileDetailRoute.addChildren([
      profileDetailIndexRoute,
      archiveRoute,
      auditRoute,
      configRoute,
      discoveryRoute,
      riskRoute,
      gateRoute,
      generalRoute,
      bulkOrderRoute,
      historyRoute,
      backtestRoute,
      notificationsRoute,
      symbolDetailRoute,
      symbolConfigRoute,
      symbolsNewRoute,
    ]),
  ]),
  accountRoute,
  backupRestoreRoute,
  settingsRoute,
]);

// Context's queryClient is wired in main.tsx via router.update; the placeholder
// keeps the type accurate without forcing module-load-time construction.
export const router = createRouter({
  routeTree,
  context: { queryClient: undefined as unknown as QueryClient },
  defaultPreload: 'intent',
  // A navigation keeps the previous route on screen until the destination's
  // loaders resolve. After sign-in that meant staring at the login form through
  // the whole account+dashboard fetch. Show a full-screen pending screen once a
  // navigation runs longer than this, held briefly so it never flickers.
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 150,
  defaultPendingMinMs: 300,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
