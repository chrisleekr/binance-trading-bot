// /profiles/$profileId/gate — the per-profile live-enablement gate. A real page
// (one full-screen surface model across the app), reached from the profile Manage
// card. Replaces the former modal so the twelve gate fields get room to breathe
// behind an Advanced disclosure instead of overflowing a dialog.

import { createRoute } from '@tanstack/react-router';

import { Page } from '@/shared/components/page';
import { EnablementPolicyPanel } from '@/features/profile/components/enablement-policy-panel';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { t } from '@/shared/lib/i18n';

function GatePage(): React.JSX.Element {
  const { profileId } = gateRoute.useParams();
  return (
    <Page>
      <ProfilePageHeader profileId={profileId} title={t('edit.gate.title')} />
      <EnablementPolicyPanel profileId={profileId} />
    </Page>
  );
}

export const gateRoute = createRoute({
  staticData: { title: t('edit.gate.title') },
  getParentRoute: () => profileDetailRoute,
  path: 'gate',
  component: GatePage,
});
