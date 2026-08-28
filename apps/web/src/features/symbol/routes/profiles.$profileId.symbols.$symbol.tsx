// /profiles/$profileId/symbols/$symbol — the per-symbol workspace. A real page
// (one full-screen surface model across the app): a compact cross-profile
// switch rail beside the workspace, each scrolling on its own. The shell drops
// <main>'s scroll+padding for this route (see __root's FULL_SCREEN_LEAVES) so
// the workspace owns its own per-zone scroll, the same as the overview at `/`.
//
// Split into a LAYOUT and an INDEX for the same reason the profile detail is: the per-symbol config page is a child, so the symbol names a rung above it in the breadcrumb and the config page has a route back. The title and the search schema stay on the layout, where both the workspace and its children inherit them.

import { useQuery } from '@tanstack/react-query';
import { createRoute, Outlet } from '@tanstack/react-router';
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
  // Stays on the LAYOUT, not the index child: the index declares no title of its own so the breadcrumb names this rung, and the document title resolves to the same string from either.
  staticData: { title: (p) => (p['symbol'] ? p['symbol'].toUpperCase() : 'Symbol') },
  getParentRoute: () => profileDetailRoute,
  path: 'symbols/$symbol',
  validateSearch: (raw: Record<string, unknown>) => searchSchema.parse(raw),
  component: () => <Outlet />,
});

export const symbolDetailIndexRoute = createRoute({
  getParentRoute: () => symbolDetailRoute,
  path: '/',
  component: SymbolWorkspacePage,
});
