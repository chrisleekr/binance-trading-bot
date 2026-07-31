import { Loader2 } from 'lucide-react';

import { t } from '@/shared/lib/i18n';

/**
 * Global route pending screen, shown once a navigation's loaders pass the
 * router's pendingMs threshold. Fixed and full-screen so it fully covers
 * whatever route is still mounted underneath during the transition. Without it
 * the router keeps the previous route on screen while loaders run, which left
 * the sign-in form visible for the whole post-login account+dashboard fetch.
 */
export function RoutePending() {
  return (
    <div
      className="bg-bg text-muted-fg fixed inset-0 z-50 flex flex-col items-center justify-center gap-3"
      role="status"
      aria-live="polite"
      data-testid="route-pending"
    >
      <Loader2 className="h-6 w-6 animate-spin" aria-hidden="true" />
      <p className="text-sm">{t('common.loading')}</p>
    </div>
  );
}
