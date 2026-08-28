// /profiles/$profileId/symbols/new — add a symbol to the profile. A real page
// (one full-screen surface model across the app).

import { createRoute } from '@tanstack/react-router';

import { Page, PageHeader } from '@/shared/components/page';
import { AddSymbolPanel } from '@/features/symbol/components/add-symbol-panel';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { t } from '@/shared/lib/i18n';

function AddSymbolPage(): React.JSX.Element {
  const { profileId } = symbolsNewRoute.useParams();
  return (
    <Page>
      {/* No `meta`: the breadcrumb above already names the owning profile. */}
      <PageHeader title={t('edit.add_symbol.title')} />
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
