// /profiles/$profileId/symbols/$symbol — the per-symbol workspace. A real page
// (one full-screen surface model across the app): a compact cross-profile
// switch rail beside the workspace, each scrolling on its own. The shell drops
// <main>'s scroll+padding for this route (see __root's full-screen check) so the
// workspace owns its own per-zone scroll, the same as the overview at `/`.

import { useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import { SymbolRail } from '@/features/dashboard/components/symbol-rail';
import { SymbolWorkspace } from '@/features/symbol/components/symbol-workspace';
import { profileDetailRoute } from '@/features/profile/routes/profiles.$profileId';
import { useScrollAnchor } from '@/shared/lib/use-scroll-anchor';

const searchSchema = z.object({
  // Which workspace section is open. `.catch(undefined)` keeps a hand-edited or
  // stale value from throwing — it degrades to the default Trade tab.
  tab: z.enum(['trade', 'orders', 'market', 'logs']).optional().catch(undefined),
});

function SymbolWorkspacePage(): React.JSX.Element {
  const { accountId, profileId, symbol: rawSymbol } = symbolDetailRoute.useParams();
  const { tab } = symbolDetailRoute.useSearch();
  // Binance pairs are uppercase-canonical; a lowercase bookmark would otherwise
  // query a symbol that does not exist.
  const symbol = rawSymbol.toUpperCase();
  const { data } = useQuery({
    ...dashboardAggregateQueryOptions(accountId),
    enabled: accountId !== '',
  });
  // Scope the rail to the open profile. The sidebar selects a profile, so the
  // workspace's symbol list should be that profile's symbols — not every
  // account's. (The rail component stays cross-profile-capable; the route is
  // what narrows it.)
  const rows = (data?.profiles ?? []).filter((p) => p.profileId === profileId);
  // WebKit has no scroll anchoring, so a polled panel reflow above the fold
  // bounces a scrolled reader on the next tick. Hold their spot on this inner
  // scroller (the shell drops <main>'s scroll for this full-screen route).
  const scrollRef = useScrollAnchor<HTMLDivElement>();
  return (
    <div className="flex min-h-0 flex-1" data-testid="terminal-workspace">
      {/* The rail lists the open profile's symbols — each one click away. Hidden
          below md (the workspace is full-bleed on a phone; its header switcher
          covers hopping there). */}
      <SymbolRail rows={rows} selected={`${profileId}:${symbol}`} />
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col overflow-y-scroll">
        <SymbolWorkspace profileId={profileId} symbol={symbol} tab={tab ?? 'trade'} />
      </div>
    </div>
  );
}

export const symbolDetailRoute = createRoute({
  staticData: { title: (p) => (p['symbol'] ? p['symbol'].toUpperCase() : 'Symbol') },
  getParentRoute: () => profileDetailRoute,
  path: 'symbols/$symbol',
  validateSearch: (raw: Record<string, unknown>) => searchSchema.parse(raw),
  component: SymbolWorkspacePage,
});
