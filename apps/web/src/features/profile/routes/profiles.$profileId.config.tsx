// /profiles/$profileId/config — the profile's strategy config editor. A real
// page (not a dashboard drawer): one full-screen surface model across the app,
// reached from the profile Manage card and deep-linkable.

import { createRoute } from '@tanstack/react-router';

import { Page } from '@/shared/components/page';
import { ProfileConfigPanel } from '@/features/profile/components/profile-config-panel';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { focusParam, useFocusConfigField } from '@/shared/lib/focus-config-field';
import { t } from '@/shared/lib/i18n';

function ProfileConfigPage(): React.JSX.Element {
  const { profileId } = configRoute.useParams();
  // `?focus=<config.path>` arrives from a diagnosis finding: expand the field's
  // collapsed ancestors and mark it, so the operator lands on the setting itself.
  useFocusConfigField(configRoute.useSearch().focus);
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
  // Only a missing, empty, or non-string `?focus=` is dropped here. A stale field
  // id survives and simply matches nothing, so a hand-edited URL cannot fail the route.
  validateSearch: (search: Record<string, unknown>): { focus?: string } => focusParam(search),
});
