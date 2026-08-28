// /profiles/$profileId/general — the profile's General settings: identity (name, quote), lifecycle (enable/disable + per-profile stop), API key, and the destructive delete. A real page reached from the sidebar's expanded profile or the phone's Profiles sheet; consolidates what used to be scattered lifecycle/admin tiles in the slide-over.

import { createRoute } from '@tanstack/react-router';

import { Page } from '@/shared/components/page';
import { ProfileGeneralPanel } from '@/features/profile/components/profile-general-panel';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { t } from '@/shared/lib/i18n';

function GeneralPage(): React.JSX.Element {
  const { profileId } = generalRoute.useParams();
  return (
    <Page>
      <ProfilePageHeader profileId={profileId} title={t('edit.general.title')} />
      <ProfileGeneralPanel profileId={profileId} />
    </Page>
  );
}

export const generalRoute = createRoute({
  staticData: { title: t('edit.general.title') },
  getParentRoute: () => profileDetailRoute,
  path: 'general',
  component: GeneralPage,
});
