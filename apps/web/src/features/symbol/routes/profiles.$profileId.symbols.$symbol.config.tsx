// /profiles/$profileId/symbols/$symbol/config — the per-symbol strategy config.
// A real page (one full-screen surface model across the app), reached from the
// symbol workspace's Config action; ‹ Back returns to that workspace.

import { createRoute } from '@tanstack/react-router';

import { BackLink, Page, PageHeader } from '@/shared/components/page';
import { SymbolConfigPanel } from '@/features/symbol/components/symbol-config-panel';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { t } from '@/shared/lib/i18n';

function SymbolConfigPage(): React.JSX.Element {
  const { accountId, profileId, symbol: rawSymbol } = symbolConfigRoute.useParams();
  const symbol = rawSymbol.toUpperCase();
  return (
    <Page>
      <PageHeader
        title={t('edit.symbol_config.title')}
        meta={symbol}
        back={
          <BackLink
            to="/accounts/$accountId/profiles/$profileId/symbols/$symbol"
            params={{ accountId, profileId, symbol }}
          />
        }
      />
      <SymbolConfigPanel profileId={profileId} symbol={symbol} />
    </Page>
  );
}

export const symbolConfigRoute = createRoute({
  staticData: {
    title: (p) => (p['symbol'] ? `${p['symbol'].toUpperCase()} config` : 'Symbol config'),
  },
  getParentRoute: () => profileDetailRoute,
  path: 'symbols/$symbol/config',
  component: SymbolConfigPage,
});
