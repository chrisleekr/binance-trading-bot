// Per-profile wallet readout for the scoped overview. Balances are reference
// info the operator wants at a glance, so they live in the main panel (this used
// to be the BALANCES dock). Single-profile only — the parent gates it; in 'all'
// scope it is not rendered.

import { useQuery } from '@tanstack/react-query';

import { Card } from '@/shared/components/ui/card';
import { t } from '@/shared/lib/i18n';
import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import { AccountBalancesPanel } from '@/features/profile/components/account-balances-panel';

export function ScopedBalances({ profileId }: { readonly profileId: string }): React.JSX.Element {
  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
  });

  return (
    // No section heading here: AccountBalancesPanel already titles itself
    // "Balances" (with the est-value readout), so an outer label would just
    // repeat it.
    <section aria-label={t('home.balances.title')} data-testid="scoped-balances">
      {dashboard.isError ? (
        // A failed read must not sit on "Loading…" forever — surface it.
        <p className="text-danger text-sm" data-testid="scoped-balances-error">
          {t('home.balances.error')}
        </p>
      ) : dashboard.data ? (
        <Card>
          <AccountBalancesPanel
            balances={dashboard.data.balances}
            symbols={dashboard.data.symbols}
            quoteAsset={dashboard.data.quoteAsset}
          />
        </Card>
      ) : (
        <p className="text-muted-fg text-sm">{t('home.balances.loading')}</p>
      )}
    </section>
  );
}
