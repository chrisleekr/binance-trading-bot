// /profiles/$profileId/discovery — the auto-discovery universe + controls. A
// real page (one full-screen surface model across the app), reached from the
// profile Manage card.

import { createRoute } from '@tanstack/react-router';

import { Page } from '@/shared/components/page';
import { DiscoveryDashboard } from '@/features/profile/components/discovery-dashboard';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { t } from '@/shared/lib/i18n';

function DiscoveryPage(): React.JSX.Element {
  const { profileId } = discoveryRoute.useParams();
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
});
