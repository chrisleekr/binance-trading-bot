// SymbolSwitcher is a header dropdown to jump between the profile's symbols
// without routing back through the profile page. Binance keeps a symbol picker
// at the top of the trade screen; this is the bot's bounded equivalent.

import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { Select } from '@/shared/components/ui/select';

/**
 * Symbol picker for the symbol-detail header. Self-contained: owns the
 * profile-dashboard query (shared cache with the profile page) and reads its
 * `symbols` list. Renders nothing until the list has loaded with at least two
 * symbols including the current one. A one-symbol profile has nowhere to
 * switch to, and a `<select>` whose value is absent from its options would
 * render a misleading blank.
 */
export function SymbolSwitcher({
  profileId,
  symbol,
}: {
  readonly profileId: string;
  readonly symbol: string;
}): React.JSX.Element | null {
  const navigate = useNavigate();
  const accountId = useActiveAccountId() ?? '';
  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
    staleTime: 5_000,
  });

  const symbols = dashboard.data?.symbols ?? [];
  if (symbols.length < 2 || !symbols.some((s) => s.symbol === symbol)) return null;

  return (
    <Select
      aria-label="Switch symbol"
      data-testid="symbol-switcher"
      className="font-medium"
      value={symbol}
      onChange={(e) => {
        const next = e.target.value;
        // Navigate to the next symbol's workspace page for the same profile.
        // The workspace remounts on the param change; `search: (prev) => prev`
        // keeps the active `?tab` across the swap.
        if (next !== symbol)
          void navigate({
            to: '/accounts/$accountId/profiles/$profileId/symbols/$symbol',
            params: { accountId, profileId, symbol: next },
            search: (prev) => prev,
          });
      }}
    >
      {symbols.map((s) => (
        <option key={s.symbol} value={s.symbol}>
          {s.symbol}
        </option>
      ))}
    </Select>
  );
}
