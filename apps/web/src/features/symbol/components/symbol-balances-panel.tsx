// Symbol balances panel — the base / quote wallet readout for the symbol.
//
// Follows Binance's "Avbl" pattern: the
// operator's free / locked holdings for the two assets that make up the
// trading pair, shown directly above the manual-trade form so the order
// size has visible context. BTCUSDT → BTC (base, what a SELL spends) and
// USDT (quote, what a BUY spends).
//
// Display-only — apps/web is barred from decimal.js, and these values never
// feed an order, so a Number round-trip for formatting is safe (same pattern
// as `formatPrice`/`SymbolStatsStrip`).

import { useQuery } from '@tanstack/react-query';

import { fetchExchangeInfo } from '@/features/symbol/api/exchange-info';
import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { formatBalanceAmount, formatBalanceMoney } from '@/shared/lib/format';
import { queryDefaults } from '@/shared/lib/query-client';

import { asDecimalString, type ProfileDashboardResponse } from '@app/contracts';

/** Balances drift only on fills; a 15s poll keeps the readout live cheaply. */
const BALANCES_REFETCH_MS = 15_000;

type AssetBalance = ProfileDashboardResponse['balances'][number];

/** The balance row for `asset`, or a synthetic zero row when the account holds none. */
function balanceFor(balances: readonly AssetBalance[], asset: string): AssetBalance {
  return (
    balances.find((b) => b.asset === asset) ?? {
      asset,
      free: asDecimalString('0'),
      locked: asDecimalString('0'),
    }
  );
}

function BalanceRow({
  role,
  balance,
  format,
}: {
  readonly role: string;
  readonly balance: AssetBalance;
  /** Per-leg formatter: money (2dp) for the quote asset, crypto quantity (up to 8dp) for the base. */
  readonly format: (value: string) => string;
}): React.JSX.Element {
  return (
    <div
      className="flex items-baseline justify-between gap-2"
      data-testid={`balance-row-${balance.asset}`}
    >
      <div className="flex flex-col">
        <span className="text-sm font-medium">{balance.asset}</span>
        <span className="text-xs tracking-wide text-muted-fg">{role}</span>
      </div>
      <div className="flex flex-col items-end tabular-nums">
        <span className="text-sm font-medium" data-testid={`balance-free-${balance.asset}`}>
          {format(balance.free)}
        </span>
        <span className="text-xs text-muted-fg">{format(balance.locked)} locked</span>
      </div>
    </div>
  );
}

/**
 * Base / quote wallet panel for the symbol-detail right rail. Self-contained:
 * owns its profile-dashboard and exchange-info queries (both keyed so they
 * share the route's caches). An asset the account does not hold renders as a
 * zero row rather than vanishing, so the operator always sees both legs of
 * the pair.
 */
export function SymbolBalancesPanel({
  profileId,
  symbol,
}: {
  readonly profileId: string;
  readonly symbol: string;
}): React.JSX.Element {
  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
    refetchInterval: BALANCES_REFETCH_MS,
    staleTime: BALANCES_REFETCH_MS,
  });
  const exchangeInfo = useQuery({
    ...queryDefaults.exchangeInfo(),
    queryFn: fetchExchangeInfo,
  });

  const pair = exchangeInfo.data?.symbols.find((s) => s.symbol === symbol);

  const body = ((): React.JSX.Element => {
    if (dashboard.isError) {
      return (
        <p className="text-sm text-muted-fg">Balances unavailable — could not load the account.</p>
      );
    }
    if (exchangeInfo.isError) {
      return (
        <p className="text-sm text-muted-fg">
          Balances unavailable — could not load exchange metadata.
        </p>
      );
    }
    if (dashboard.isLoading || exchangeInfo.isLoading) {
      // Two rows: the base and quote balances the loaded body renders.
      return <LoadingRows rows={2} />;
    }
    if (!pair) {
      return <p className="text-sm text-muted-fg">No exchange metadata for {symbol}.</p>;
    }
    const balances = dashboard.data?.balances ?? [];
    return (
      <div className="space-y-3">
        {/* Base = the coin being traded (a quantity, varying precision); Quote =
            what it is priced in (money, 2dp). Formatting them the same made the
            USDT wallet read 29.15892558 next to the manual-trade panel's 29.16. */}
        <BalanceRow
          role="Base"
          balance={balanceFor(balances, pair.baseAsset)}
          format={formatBalanceAmount}
        />
        <div className="border-t border-border" />
        <BalanceRow
          role="Quote"
          balance={balanceFor(balances, pair.quoteAsset)}
          format={formatBalanceMoney}
        />
      </div>
    );
  })();

  return (
    <section className="space-y-3" data-testid="symbol-balances-panel">
      <h2 className="text-sm font-semibold">Balances</h2>
      {body}
    </section>
  );
}
