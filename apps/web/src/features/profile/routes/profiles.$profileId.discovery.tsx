// /profiles/$profileId/discovery — the auto-discovery universe + controls. A real page (one full-screen surface model across the app), reached from the sidebar's expanded profile or the phone's Profiles sheet.

import { createRoute } from '@tanstack/react-router';

import { Page } from '@/shared/components/page';
import { DiscoveryDashboard } from '@/features/profile/components/discovery-dashboard';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { focusParam, useFocusConfigField } from '@/shared/lib/focus-config-field';
import { t } from '@/shared/lib/i18n';

function DiscoveryPage(): React.JSX.Element {
  const { profileId } = discoveryRoute.useParams();
  // `?focus=<config.path>` arrives from a diagnosis finding: expand the field's
  // collapsed ancestors and mark it, so the operator lands on the setting itself.
  useFocusConfigField(discoveryRoute.useSearch().focus);
  return (
    <Page>
      <ProfilePageHeader profileId={profileId} title={t('edit.discovery.title')} />
      <DiscoveryDashboard profileId={profileId} />
    </Page>
  );
}

export const discoveryRoute = createRoute({
  staticData: { title: t('edit.discovery.title') },
  getParentRoute: () => profileDetailRoute,
  path: 'discovery',
  component: DiscoveryPage,
  // Only a missing, empty, or non-string `?focus=` is dropped here. A stale field
  // id survives and simply matches nothing, so a hand-edited URL cannot fail the route.
  validateSearch: (search: Record<string, unknown>): { focus?: string } => focusParam(search),
});
