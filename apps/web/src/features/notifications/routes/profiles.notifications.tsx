// /profiles/$profileId/notifications — the per-profile notifier editor. A real page (one full-screen surface model across the app), reached from the sidebar's expanded profile or the phone's Profiles sheet, and deep-linkable.

import { createRoute } from '@tanstack/react-router';

import { Page } from '@/shared/components/page';
import { NotificationsPanel } from '@/features/notifications/components/notifications-panel';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { t } from '@/shared/lib/i18n';

function NotificationsPage(): React.JSX.Element {
  const { profileId } = notificationsRoute.useParams();
  return (
    <Page>
      <ProfilePageHeader profileId={profileId} title={t('edit.notifications.title')} />
      <NotificationsPanel profileId={profileId} />
    </Page>
  );
}

export const notificationsRoute = createRoute({
  staticData: { title: t('edit.notifications.title') },
  getParentRoute: () => profileDetailRoute,
  path: 'notifications',
  component: NotificationsPage,
});
