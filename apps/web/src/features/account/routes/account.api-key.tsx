// /accounts/$accountId/api-key — the Binance API-key form. The key pair belongs
// to the account (one key = one Binance account = one environment); every
// profile under the account shares it. A real page (one full-screen surface
// model across the app), reached from the dashboard's "add API key" prompt.

import { createRoute } from '@tanstack/react-router';

import { Page, PageHeader } from '@/shared/components/page';
import { ApiKeyPanel } from '@/features/profile/components/api-key-panel';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { t } from '@/shared/lib/i18n';

function ApiKeyPage(): React.JSX.Element {
  return (
    <Page>
      <PageHeader title={t('edit.api_key.title')} />
      <ApiKeyPanel />
    </Page>
  );
}

export const apiKeyRoute = createRoute({
  staticData: { title: t('edit.api_key.title') },
  getParentRoute: () => accountScopeRoute,
  path: '/api-key',
  component: ApiKeyPage,
});
