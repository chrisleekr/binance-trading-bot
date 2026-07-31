import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  Outlet,
  redirect,
  useLocation,
  useMatches,
  useRouter,
} from '@tanstack/react-router';

import { AppShell } from '@/app/app-shell';
import { useDocumentTitle } from '@/app/use-document-title';
import { ErrorBoundary } from '@/shared/components/error-boundary';
import { LiveProfileProvider } from '@/features/profile/components/live-profile-provider';
import { AccountSwitcher } from '@/features/account/components/account-switcher';
import { ProfileSwitcher } from '@/features/profile/components/profile-switcher';
import { TimezoneProvider } from '@/shared/context/timezone-context';
import { RouteErrorCard } from '@/shared/components/route-error-card';
import { Button } from '@/shared/components/ui/button';
import { Toaster } from '@/shared/components/ui/sonner';
import { TooltipProvider } from '@/shared/components/ui/tooltip';
import { t } from '@/shared/lib/i18n';
import { resolveOnboardingRedirect } from '@/features/auth/api/auth';

export interface RouterContext {
  queryClient: QueryClient;
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    const redirectTo = await resolveOnboardingRedirect(context.queryClient, location.pathname);
    // `to`, not `href`: an `href` redirect bypasses the typed route match and
    // leaves the SPA mounting a blank tree. Both targets are real routes.
    if (redirectTo) throw redirect({ to: redirectTo });
  },
  component: RootComponent,
  errorComponent: RootErrorComponent,
  notFoundComponent: NotFoundComponent,
});

const PUBLIC_PATHS = new Set<string>(['/login', '/onboarding']);

function RootComponent() {
  const { pathname } = useLocation();
  useDocumentTitle();
  // Public auth pages (login/onboarding) render a self-contained centred card
  // and must not show the authenticated nav chrome — sidebar/bottom-nav links
  // would only bounce a signed-out visitor back here.
  const isPublic = PUBLIC_PATHS.has(pathname);
  // The terminal overview (`/`) and the per-symbol workspace own their own
  // per-zone scroll, so the shell must not also scroll/pad <main>. Match the
  // workspace by its exact leaf route id, not a path regex: the sibling
  // `symbols/new` (add-symbol page) and the `/config` child are normal
  // scrolling pages and a `[^/]+` regex would wrongly catch `new`.
  const leafRouteId = useMatches().at(-1)?.routeId;
  // The dashboard (account overview + per-profile overview) and the symbol
  // workspace own their own per-zone scroll, so the shell must not also scroll
  // <main>. Match by exact leaf route id under the account scope.
  const FULL_SCREEN_LEAVES = new Set<string>([
    '/accounts/$accountId/',
    '/accounts/$accountId/profiles/$profileId/',
    '/accounts/$accountId/profiles/$profileId/symbols/$symbol',
  ]);
  const fullScreen = leafRouteId !== undefined && FULL_SCREEN_LEAVES.has(leafRouteId);
  return (
    <TooltipProvider delayDuration={150}>
      <TimezoneProvider>
        <LiveProfileProvider>
          {isPublic ? (
            <div className="bg-bg text-fg flex min-h-dvh flex-col items-center justify-center p-4">
              <ErrorBoundary>
                <Outlet />
              </ErrorBoundary>
            </div>
          ) : (
            <AppShell
              headerSlot={
                // The account switcher is always in the top bar (the account is
                // the top scope level). The profile switcher beside it is
                // mobile-only — desktop switches profiles via the sidebar list.
                <div className="flex items-center gap-2">
                  <AccountSwitcher />
                  <div className="md:hidden">
                    <ProfileSwitcher />
                  </div>
                </div>
              }
              disableMainScroll={fullScreen}
            >
              <ErrorBoundary>
                <Outlet />
              </ErrorBoundary>
            </AppShell>
          )}
        </LiveProfileProvider>
      </TimezoneProvider>
      <Toaster />
    </TooltipProvider>
  );
}

// Rendered for any URL that matches no route. Without this, TanStack
// Router falls back to a bare unstyled default — so the broken /profiles
// nav link (and any other stale URL) landed users on a blank screen.
// Renders inside RootComponent's <Outlet>, which is already wrapped in
// TooltipProvider + AppShell + Toaster — so this must NOT re-wrap them,
// or the page draws a second nested sidebar/header.
function NotFoundComponent() {
  const router = useRouter();
  return (
    <section
      className="border-border bg-bg-elevated mx-auto flex max-w-md flex-col items-center gap-3 rounded-md border p-6 text-center"
      data-testid="not-found"
    >
      <h1 className="text-lg font-semibold">{t('notfound.title')}</h1>
      <p className="text-muted-fg text-sm">{t('notfound.body')}</p>
      <Button onClick={() => router.history.push('/')}>{t('notfound.cta')}</Button>
    </section>
  );
}

function RootErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const onRetry = (): void => {
    reset();
    void router.invalidate();
  };
  return (
    <TooltipProvider delayDuration={150}>
      <AppShell>
        <RouteErrorCard error={error} onRetry={onRetry} />
      </AppShell>
      <Toaster />
    </TooltipProvider>
  );
}
