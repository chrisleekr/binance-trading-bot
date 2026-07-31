// /profiles/$profileId/symbols/new — add a symbol to the profile. A real page
// (one full-screen surface model across the app).

import { createRoute } from '@tanstack/react-router';

import { BackLink, Page, PageHeader } from '@/shared/components/page';
import { AddSymbolPanel } from '@/features/symbol/components/add-symbol-panel';
import { useProfileName } from '@/features/profile/lib/use-profile-name';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { t } from '@/shared/lib/i18n';

function AddSymbolPage(): React.JSX.Element {
  const { profileId } = symbolsNewRoute.useParams();
  return (
    <Page>
      <PageHeader
        title={t('edit.add_symbol.title')}
        meta={useProfileName(profileId)}
        back={<BackLink to="/" />}
      />
      <AddSymbolPanel profileId={profileId} />
    </Page>
  );
}

export const symbolsNewRoute = createRoute({
  staticData: { title: t('edit.add_symbol.title') },
  getParentRoute: () => profileDetailRoute,
  path: 'symbols/new',
  component: AddSymbolPage,
});
