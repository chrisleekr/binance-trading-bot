// /profiles/$profileId/risk — the per-profile risk controls. A real page (one
// full-screen surface model across the app), reached from the profile Manage
// card.

import { createRoute } from '@tanstack/react-router';

import { Page } from '@/shared/components/page';
import { RiskPanel } from '@/features/profile/components/risk-panel';
import { ProfilePageHeader } from '@/features/profile/components/profile-page-header';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { focusParam, useFocusConfigField } from '@/shared/lib/focus-config-field';
import { t } from '@/shared/lib/i18n';

function RiskPage(): React.JSX.Element {
  const { profileId } = riskRoute.useParams();
  // `?focus=<config.path>` arrives from a diagnosis finding: expand the field's
  // collapsed ancestors and mark it, so the operator lands on the setting itself.
  useFocusConfigField(riskRoute.useSearch().focus);
  return (
    <Page>
      <ProfilePageHeader profileId={profileId} title={t('edit.risk.title')} />
      <RiskPanel profileId={profileId} />
    </Page>
  );
}

export const riskRoute = createRoute({
  staticData: { title: t('edit.risk.title') },
  getParentRoute: () => profileDetailRoute,
  path: 'risk',
  component: RiskPage,
  // Only a missing, empty, or non-string `?focus=` is dropped here. A stale field
  // id survives and simply matches nothing, so a hand-edited URL cannot fail the route.
  validateSearch: (search: Record<string, unknown>): { focus?: string } => focusParam(search),
});
