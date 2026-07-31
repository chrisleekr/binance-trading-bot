// /profiles/$profileId/config — the profile's strategy config editor. A real
// page (not a dashboard drawer): one full-screen surface model across the app,
// reached from the profile Manage card and deep-linkable.

import { createRoute } from '@tanstack/react-router';

import { Page } from '@/shared/components/page';
import { ProfileConfigPanel } from '@/features/profile/components/profile-config-panel';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { t } from '@/shared/lib/i18n';

function ProfileConfigPage(): React.JSX.Element {
  const { profileId } = configRoute.useParams();
  return (
    <Page>
      <ProfilePageHeader profileId={profileId} title={t('edit.profile_config.title')} />
      <ProfileConfigPanel profileId={profileId} />
    </Page>
  );
}

export const configRoute = createRoute({
  staticData: { title: t('edit.profile_config.title') },
  getParentRoute: () => profileDetailRoute,
  path: 'config',
  component: ProfileConfigPage,
});
