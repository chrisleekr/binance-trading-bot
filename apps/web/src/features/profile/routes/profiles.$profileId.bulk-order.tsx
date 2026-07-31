// /profiles/$profileId/bulk-order — place several orders across the profile's
// symbols at once. A real page (one full-screen surface model across the app),
// reached from the profile Manage card's More set.

import { createRoute } from '@tanstack/react-router';

import { Page } from '@/shared/components/page';
import { BulkOrderDrawer } from '@/features/profile/components/bulk-order-drawer';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { t } from '@/shared/lib/i18n';

function BulkOrderPage(): React.JSX.Element {
  const { profileId } = bulkOrderRoute.useParams();
  return (
    <Page>
      <ProfilePageHeader profileId={profileId} title={t('edit.bulk_order.title')} />
      <BulkOrderDrawer profileId={profileId} />
    </Page>
  );
}

export const bulkOrderRoute = createRoute({
  staticData: { title: t('edit.bulk_order.title') },
  getParentRoute: () => profileDetailRoute,
  path: 'bulk-order',
  component: BulkOrderPage,
});
