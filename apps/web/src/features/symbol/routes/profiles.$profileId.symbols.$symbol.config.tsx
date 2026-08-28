// /profiles/$profileId/symbols/$symbol/config — the per-symbol strategy config. A real page (one full-screen surface model across the app), reached from the symbol workspace's Config action.
//
// A CHILD of the symbol workspace, so the trail reads Home > <profile> > BTCUSDT > Config and the symbol rung is the route back to the workspace this page was opened from. `crumb` overrides the document title for that rung: the title stands alone in a browser tab and so keeps naming the symbol, which would stutter as a trail rung directly under the symbol itself.

import { createRoute } from '@tanstack/react-router';

import { Page, PageHeader } from '@/shared/components/page';
import { SymbolConfigPanel } from '@/features/symbol/components/symbol-config-panel';
import { symbolDetailRoute } from '@/features/symbol/routes/profiles.$profileId.symbols.$symbol';
import { t } from '@/shared/lib/i18n';

function SymbolConfigPage(): React.JSX.Element {
  const { profileId, symbol: rawSymbol } = symbolConfigRoute.useParams();
  const symbol = rawSymbol.toUpperCase();
  return (
    <Page>
      <PageHeader title={t('edit.symbol_config.title')} meta={symbol} />
      <SymbolConfigPanel profileId={profileId} symbol={symbol} />
    </Page>
  );
}

export const symbolConfigRoute = createRoute({
  staticData: {
    title: (p) => (p['symbol'] ? `${p['symbol'].toUpperCase()} config` : 'Symbol config'),
    crumb: 'Config',
  },
  getParentRoute: () => symbolDetailRoute,
  path: 'config',
  component: SymbolConfigPage,
});
