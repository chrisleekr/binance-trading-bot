// The mobile shape of the sidebar's expanded profile. Below `md` the sidebar is hidden, so without this the phone reached two of the app's destinations and every profile section was unreachable from navigation.
//
// Reads PROFILE_NAV_ITEMS — the same list the sidebar renders — so a new profile section appears on the phone without anyone remembering to add it here.

import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Plus, ShieldAlert } from 'lucide-react';
import { useRef, useState } from 'react';

import { NEW_PROFILE_ITEM } from '@/app/side-nav';
import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import { PROFILE_NAV_ITEMS } from '@/features/profile/lib/profile-sections';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/shared/components/ui/sheet';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { cn } from '@/shared/lib/cn';
import { visibleInDemo } from '@/shared/lib/demo-visibility';
import { t } from '@/shared/lib/i18n';
import { useOverflowEdges } from '@/shared/lib/use-overflow-edges';

import type { DashboardAggregateResponse } from '@app/contracts';

/** Row height that clears the 44x44 touch target on every entry in the sheet. */
const ROW = 'flex min-h-11 items-center gap-2.5 rounded px-3 text-sm';

/**
 * The scrolling profile list, with a fade at each edge that still has rows past it.
 *
 * Its own component, and that is load-bearing rather than tidiness. `useOverflowEdges` keys its effect on ref identity, so it wires up exactly once per mount and never again, while Radix unmounts `SheetContent` entirely whenever the sheet is closed. Left in the always-mounted sheet wrapper the hook would run once against a scroller that does not exist yet and stay that way, shipping an affordance that can never appear. Mounting with the sheet's content is what gives it a real element to measure.
 *
 * @param profiles - Every profile on the active account, in the order the dashboard returned them.
 * @param accountId - The active account, which every link in the list is nested under.
 * @param routeProfileId - The profile the current route is inside, or null; that one profile expands to show its sections.
 * @param demoMode - Public live demo: drops every row whose destination declared itself demo-hidden. The phone has no other navigation, so a row leading to a 403 is the whole surface being wrong rather than a cosmetic slip.
 * @param onNavigate - Called when any row is chosen, so the sheet closes rather than sitting over the page it just opened.
 * @returns The scroller, its list, and the two edge fades.
 */
function ProfilesSheetList({
  profiles,
  accountId,
  routeProfileId,
  demoMode,
  onNavigate,
}: {
  readonly profiles: DashboardAggregateResponse['profiles'];
  readonly accountId: string;
  readonly routeProfileId: string | null;
  readonly demoMode: boolean;
  readonly onNavigate: () => void;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const edges = useOverflowEdges(scrollRef, contentRef);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-testid="mobile-profiles-scroll"
        data-overflow-top={edges.top}
        data-overflow-bottom={edges.bottom}
        className="h-full overflow-y-auto"
      >
        {/* One stable wrapper, never conditionally rendered: it is the element the overflow hook's ResizeObserver watches, and expanding a profile changes ITS height without touching the scroller's own box or firing a scroll event. */}
        <div ref={contentRef}>
          <nav aria-label={t('nav.profiles')} className="space-y-1 pb-4">
            {profiles.map((p) => {
              const active = routeProfileId === p.profileId;
              return (
                <div key={p.profileId}>
                  <Link
                    to="/accounts/$accountId/profiles/$profileId"
                    params={{ accountId, profileId: p.profileId }}
                    onClick={onNavigate}
                    // exact, for the same reason ProfileNavLink needs it: this row points at the profile OVERVIEW, so the router's default non-exact matching would stamp aria-current="page" on it from every section beneath the profile, leaving two elements in one nav both claiming to be the current page. A hand-written aria-current cannot fix that here, because the router spreads its own active props last and would overwrite it.
                    activeOptions={{ exact: true }}
                    className={cn(ROW, 'font-medium', active ? 'text-accent' : 'text-fg')}
                  >
                    {p.killSwitch ? (
                      <ShieldAlert className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                    ) : (
                      <span
                        className={cn(
                          'inline-block h-2 w-2 shrink-0 rounded-full',
                          p.enabled ? 'bg-success' : 'border border-muted-fg',
                        )}
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate">{p.name}</span>
                  </Link>
                  {/* Only the active profile expands. Every profile expanded would bury the list the sheet exists to show. */}
                  {active && (
                    <div className="border-l border-border/60 pl-3">
                      {PROFILE_NAV_ITEMS.filter((item) => visibleInDemo(item, demoMode)).map(
                        (item) => (
                          <Link
                            key={item.to}
                            to={item.to}
                            params={{ accountId, profileId: p.profileId }}
                            onClick={onNavigate}
                            activeOptions={{
                              exact: item.to === '/accounts/$accountId/profiles/$profileId',
                            }}
                            className={cn(ROW, 'text-muted-fg')}
                            activeProps={{ className: cn(ROW, 'font-medium text-accent') }}
                          >
                            <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="truncate">{item.label}</span>
                          </Link>
                        ),
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {visibleInDemo(NEW_PROFILE_ITEM, demoMode) && (
              <Link
                to="/accounts/$accountId/profiles/new"
                params={{ accountId }}
                onClick={onNavigate}
                className={cn(ROW, 'text-muted-fg')}
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{t('nav.new_profile')}</span>
              </Link>
            )}
          </nav>
        </div>
      </div>
      {/* The scroll affordance, the same one the sidebar carries. Overlay scrollbars on iOS stay invisible until the operator is already dragging, so without this a clipped profile list reads as a list that simply ends — and this sheet clips at ONE profile once a profile is expanded, since ten section rows at 44px each is more room than the cap leaves. Rendered conditionally rather than faded via opacity so a list that fits has no decoration over its first and last rows at all. */}
      {edges.top && (
        <div
          data-testid="mobile-profiles-fade-top"
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-bg-elevated to-transparent"
        />
      )}
      {edges.bottom && (
        <div
          data-testid="mobile-profiles-fade-bottom"
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-bg-elevated to-transparent"
        />
      )}
    </div>
  );
}

/**
 * The bottom nav's `Profiles` destination: a sheet listing every profile with its status dot, and the active profile's sections nested under it. Two taps reach any profile page, which is the parity the bottom nav's two static links could not offer.
 *
 * @param trigger - The bottom-nav button that opens the sheet, so the bar owns its own layout and this owns only the panel.
 * @param demoMode - Public live demo: drops every row whose destination declared itself demo-hidden. The phone has no other navigation, so a row leading to a 403 is the whole surface being wrong rather than a cosmetic slip.
 * @returns The trigger with its sheet.
 */
export function MobileProfilesSheet({
  trigger,
  demoMode,
}: {
  readonly trigger: React.ReactNode;
  readonly demoMode: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const accountId = useActiveAccountId() ?? '';
  const routeProfileId = useParams({ strict: false }).profileId ?? null;
  const { data } = useQuery({
    ...dashboardAggregateQueryOptions(accountId),
    enabled: accountId !== '',
  });
  const profiles = data?.profiles ?? [];

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      {/* Bottom sheet, not the desktop right slide-over: it opens beside the thumb that tapped the bar. A column, so the cap bounds the panel while the list alone scrolls inside it and the header stays put — which is also what lets the bottom fade sit on the edge of the list rather than on the edge of the header-plus-list. */}
      <SheetContent
        side="bottom"
        className="flex max-h-[85svh] flex-col"
        data-testid="mobile-profiles-sheet"
      >
        <SheetHeader className="shrink-0">
          <SheetTitle>{t('nav.profiles')}</SheetTitle>
        </SheetHeader>
        <ProfilesSheetList
          profiles={profiles}
          accountId={accountId}
          routeProfileId={routeProfileId}
          demoMode={demoMode}
          onNavigate={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}
