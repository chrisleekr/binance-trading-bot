// "When this coin gets removed" panel for the symbol page.
//
// The symbol-state response carries no discovery awareness, so this reads the
// profile's discovery-dashboard payload (shared query cache with the profile
// page) to answer the one question an operator asks on an auto-discovered
// symbol: when will the bot drop it? Removal is not a scheduled event — it
// needs the coin to stop trending AND be flat AND have aged past min-hold — so
// we state those conditions plainly instead of a countdown that may never fire.
// Renders nothing for a manually-added symbol (discovery does not manage it).

import { useQuery } from '@tanstack/react-query';

import {
  discoveryDashboardQueryKey,
  fetchDiscoveryDashboard,
} from '@/features/profile/api/discovery';
import { Badge } from '@/shared/components/ui/badge';
import { Card } from '@/shared/components/ui/card';

/** Humanise the min-hold for a non-finance operator: minutes under an hour, else hours. */
function formatHold(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
}

export function SymbolDiscoveryStatus({
  profileId,
  symbol,
  flat,
}: {
  readonly profileId: string;
  readonly symbol: string;
  // No open position AND no resting orders — the discovery reap's flat-guard
  // condition. A non-flat symbol is never auto-dropped.
  readonly flat: boolean;
}): React.JSX.Element | null {
  const dashboard = useQuery({
    queryKey: discoveryDashboardQueryKey(profileId),
    queryFn: () => fetchDiscoveryDashboard(profileId),
    staleTime: 5_000,
  });

  const data = dashboard.data;
  // Supplementary panel: stay invisible until we know the symbol is auto-managed
  // rather than flashing a spinner or an error on the symbol page.
  if (!data || !data.autoSymbols.includes(symbol)) return null;

  const hold = formatHold(data.config.minHoldMinutes);
  // The universe is a frozen snapshot of the last scan; an auto symbol can be
  // absent from it (just pinned/unpinned, or first scan) — fall back to the
  // generic "stays while trending" wording when its disposition is unknown.
  const disposition = data.universe?.candidates.find((c) => c.symbol === symbol)?.disposition;

  let headline: string;
  let rule: string | null =
    `Auto-discovery drops a coin only once all three are true: it stops trending, it is flat (no position and no open orders), and it has been held at least ${hold}.`;

  if (!data.config.enabled) {
    headline =
      "Auto-discovery is paused for this profile, so this coin won't be rotated out until it's switched back on.";
    rule = null;
  } else if (!flat) {
    headline =
      "You're holding this coin (a position or open orders), so auto-discovery won't remove it. It can only leave rotation once it's fully flat.";
  } else if (disposition === 'faded-removed') {
    headline =
      "It's stopped trending and its minimum hold has elapsed, so it'll be dropped to cash on the next discovery scan.";
  } else if (disposition === 'faded-held') {
    headline = `It's stopped trending and is now waiting out its ${hold} minimum hold. Once that elapses it'll be dropped on the next scan.`;
  } else {
    headline =
      "It's still trending, so it stays in rotation. It'll be dropped only after it stops trending.";
  }

  return (
    <Card data-testid="symbol-discovery-status" className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          aria-label={`${symbol} auto-discovered`}
          title="Rotated in by auto-discovery (not operator-added)."
        >
          auto-discovered
        </Badge>
        <h2 className="text-fg text-sm font-semibold">When this coin gets removed</h2>
      </div>
      <p className="text-fg text-sm">{headline}</p>
      {rule ? <p className="text-muted-fg text-xs">{rule}</p> : null}
    </Card>
  );
}
