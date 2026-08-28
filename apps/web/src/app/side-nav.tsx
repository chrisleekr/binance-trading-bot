import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  Coins,
  HardDrive,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  ShieldAlert,
  Unlink,
  Wallet,
} from 'lucide-react';
import { useRef, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';

import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import { PROFILE_NAV_ITEMS } from '@/features/profile/lib/profile-sections';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip';
import { cn } from '@/shared/lib/cn';
import { visibleInDemo, type DemoVisible } from '@/shared/lib/demo-visibility';
import { t, type I18nKey } from '@/shared/lib/i18n';
import { useOverflowEdges } from '@/shared/lib/use-overflow-edges';

import type { DashboardAggregateRow } from '@app/contracts';

const COLLAPSED_KEY = 'side-nav-collapsed';

/**
 * Profile-dot tone for the sidebar, by signal priority. Kill-switch is handled
 * separately (a red shield, not a dot). Disabled reads as a hollow muted ring so
 * it is distinguishable by shape, not colour alone; an enabled profile is green
 * when ticking, red on a tick error, muted while awaiting its first tick.
 */
function profileDot(p: DashboardAggregateRow): { cls: string; label: string } {
  if (!p.enabled) return { cls: 'border border-muted-fg', label: 'Disabled' };
  if (p.lastTickError !== null) return { cls: 'bg-danger', label: 'Tick error' };
  if (p.lastTickAt !== null) return { cls: 'bg-success', label: 'Live' };
  return { cls: 'bg-muted-fg', label: 'Idle — awaiting first tick' };
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

interface StaticItem extends DemoVisible {
  readonly to:
    | '/accounts/$accountId'
    | '/settings'
    | '/settings/backup-restore'
    | '/accounts/$accountId/profiles/new'
    | '/accounts/$accountId/settings'
    | '/accounts/$accountId/dust-transfer'
    | '/accounts/$accountId/orphan-orders';
  readonly labelKey: I18nKey;
  readonly Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Match the route exactly (Home would otherwise stay lit on every page). */
  readonly exact?: boolean;
}

export const MONITOR_ITEMS: readonly StaticItem[] = [
  { to: '/accounts/$accountId', labelKey: 'nav.home', Icon: Home, exact: true, demoHidden: false },
];

// Account-scoped destinations. These act on ONE account's wallet and order book,
// and the sidebar knows which: `accountId` comes from the URL via
// `useActiveAccountId`, and `Item` substitutes it. Top-level rather than nested
// under account settings, because these are the pages the operator reaches for
// when something has gone wrong on the exchange, and they should be one click away.
/** Exported on its own because the account switcher in the top bar reaches the same destination from a button, and must obey the same answer rather than restating it. */
export const ACCOUNT_SETTINGS_ITEM: StaticItem = {
  // Hosts the account's api-key surface, which 403s for the demo operator.
  to: '/accounts/$accountId/settings',
  labelKey: 'nav.manage_account',
  Icon: Wallet,
  exact: true,
  demoHidden: true,
};

export const ACCOUNT_ITEMS: readonly StaticItem[] = [
  ACCOUNT_SETTINGS_ITEM,
  {
    // Testnet wallet housekeeping against the account's own balances, with no guarded route behind it. The sandbox is meant to be interactive and the nightly reset undoes whatever a visitor does.
    to: '/accounts/$accountId/dust-transfer',
    labelKey: 'nav.dust_transfer',
    Icon: Coins,
    demoHidden: false,
  },
  {
    // Same reasoning as dust transfer: it reconciles the account's own testnet orders, fronts no guarded route, and the nightly reset undoes it.
    to: '/accounts/$accountId/orphan-orders',
    labelKey: 'nav.orphan_orders',
    Icon: Unlink,
    demoHidden: false,
  },
];

/** Exported for the same reason ACCOUNT_SETTINGS_ITEM is: the mobile Profiles sheet renders this row too, and both surfaces must read one answer. Not part of a section registry — it is hand-placed at the end of the profile list, where it reads as "and one more". */
export const NEW_PROFILE_ITEM: StaticItem = {
  to: '/accounts/$accountId/profiles/new',
  labelKey: 'nav.new_profile',
  Icon: Plus,
  // Creating a profile is an ordinary write on the operator's own account; only `POST /accounts` is demo-guarded.
  demoHidden: false,
};

/** Exported so the header's settings icon (app-shell) reads this answer instead of hard-coding a third copy of it. */
export const SETTINGS_ITEM: StaticItem = {
  to: '/settings',
  labelKey: 'nav.settings',
  Icon: Settings,
  exact: true,
  demoHidden: true,
};

// Operator-global only: these belong to no single account. Both front credential or backup surfaces, so the whole section empties out in the demo.
export const SYSTEM_ITEMS: readonly StaticItem[] = [
  SETTINGS_ITEM,
  {
    to: '/settings/backup-restore',
    labelKey: 'nav.backup_restore',
    Icon: HardDrive,
    demoHidden: true,
  },
];

/**
 * Desktop-only collapsible left sidebar (v2 terminal chrome). Global destinations under uppercase section labels, plus a live profile list. The active profile expands inline into its own sections, so the sidebar answers "where can I go" and the breadcrumb answers "where am I" — the profile's pages used to live only inside a modal drawer, which could show neither. Collapses to an icon rail; the choice persists in localStorage. Mobile gets the BottomNav — this never renders below `md`.
 */
export function SideNav({
  className,
  demoMode = false,
}: {
  className?: string;
  // Live demo: every row comes from a registry that declares its own demo visibility, so the sidebar filters rather than deciding.
  demoMode?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const profilesScrollRef = useRef<HTMLDivElement>(null);
  const profilesContentRef = useRef<HTMLDivElement>(null);
  const profilesEdges = useOverflowEdges(profilesScrollRef, profilesContentRef);
  const accountId = useActiveAccountId() ?? '';
  const routeProfileId = useParams({ strict: false }).profileId ?? null;
  const { data } = useQuery({
    ...dashboardAggregateQueryOptions(accountId),
    enabled: accountId !== '',
  });
  const profiles = data?.profiles ?? [];
  // One rule for every registry-driven section: filter, then render the section only if something survived. A section label over no rows reads as a list that failed to load.
  const shown = (items: readonly StaticItem[]): readonly StaticItem[] =>
    items.filter((item) => visibleInDemo(item, demoMode));
  const monitorItems = shown(MONITOR_ITEMS);
  const accountItems = shown(ACCOUNT_ITEMS);
  const systemItems = shown(SYSTEM_ITEMS);
  const newProfileItem = visibleInDemo(NEW_PROFILE_ITEM, demoMode) ? NEW_PROFILE_ITEM : null;

  const toggle = (): void => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        // Private-mode storage failure only loses persistence, not function.
      }
      return next;
    });
  };

  return (
    <nav
      aria-label="Sidebar"
      data-testid="side-nav"
      data-collapsed={collapsed}
      // The rail keeps its own `overflow-y-auto` on purpose even though the profile list now owns the scrolling. It is the degenerate-viewport fallback: below roughly 550px of window height the profile list has already given up everything it can and is sitting on its 5.5rem floor, so the pinned chrome (~439px of sections plus the footer) plus that floor no longer fit and it is the RAIL that overflows. A non-scrolling rail would clip the collapse control there with no way to reach it. Above that height this never engages, because everything below the profile list is `shrink-0` and the list absorbs the rest.
      className={cn(
        'shrink-0 flex-col overflow-y-auto border-r border-border bg-bg-elevated',
        collapsed ? 'w-[52px]' : 'w-52',
        className,
      )}
    >
      {monitorItems.length > 0 && (
        <Section labelKey="nav.section.monitor" collapsed={collapsed} className="shrink-0">
          {monitorItems.map((item) => (
            <Item key={item.to} item={item} accountId={accountId} collapsed={collapsed} />
          ))}
        </Section>
      )}

      {/* The only section allowed to give. `flex-1` hands it the height left over after the pinned sections, and letting it shrink below its CONTENT is the fix — a flex item refuses to by default, which is precisely how the profile list used to push ACCOUNT, SYSTEM and the collapse control past the bottom of the rail. Shrinking to ZERO would be a different bug, though, and `min-h-0` alone permits exactly that: a section that SHRANK has nothing left for the rail's fallback scroll to reveal, so below ~549px of window height no profile would be reachable at all. The floor is 5.5rem/88px: ~37px of the section's own chrome (py-2 + label + border) leaves room for one full 44px row plus its scroll region, and past that the rail overflows and its own `overflow-y-auto` keeps everything reachable. Inert at any normal viewport — at 1280x768 this section gets ~256px. */}
      <Section
        labelKey="nav.section.profiles"
        collapsed={collapsed}
        className="flex min-h-[5.5rem] flex-1 flex-col"
      >
        <div className="relative min-h-0 flex-1">
          <div
            ref={profilesScrollRef}
            data-testid="side-nav-profiles-scroll"
            data-overflow-top={profilesEdges.top}
            data-overflow-bottom={profilesEdges.bottom}
            className="h-full overflow-y-auto"
          >
            {/* One stable wrapper, never conditionally rendered: it is the element the overflow hook's ResizeObserver watches, and expanding a profile changes ITS height without touching the scroller's own box or firing a scroll event. */}
            <div ref={profilesContentRef}>
              {profiles.map((p) => {
                const dot = profileDot(p);
                const active = routeProfileId === p.profileId;
                return (
                  <div key={p.profileId}>
                    <ProfileNavLink
                      label={p.name}
                      accountId={accountId}
                      profileId={p.profileId}
                      active={active}
                      collapsed={collapsed}
                      icon={
                        p.killSwitch ? (
                          <ShieldAlert
                            className="h-4 w-4 shrink-0 text-danger"
                            aria-hidden="true"
                          />
                        ) : (
                          <span
                            className={cn(
                              'mx-1 inline-block h-2 w-2 shrink-0 rounded-full',
                              dot.cls,
                            )}
                            title={dot.label}
                            aria-hidden="true"
                          />
                        )
                      }
                    />
                    {/* The profile's own sections, inline. A modal drawer could not
                  show where you are among siblings, so moving between two
                  settings an operator tunes together cost three clicks. Only the
                  active profile expands: every profile expanded would bury the
                  profile list under ten rows each. Hidden on the icon rail,
                  where a nested list has no room to read as nested. */}
                    {active && !collapsed && (
                      <div className="border-l border-border/60 pb-1 pl-3">
                        {PROFILE_NAV_ITEMS.filter((item) => visibleInDemo(item, demoMode)).map(
                          (item) => (
                            <NavLink
                              key={item.to}
                              to={item.to}
                              params={{ accountId, profileId: p.profileId }}
                              label={item.label}
                              collapsed={false}
                              // Overview is the profile route itself; without an exact
                              // match it would stay lit on every section beneath it.
                              exact={item.to === '/accounts/$accountId/profiles/$profileId'}
                              icon={
                                <item.icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              }
                              dense
                            />
                          ),
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {newProfileItem && (
                <Item item={newProfileItem} accountId={accountId} collapsed={collapsed} />
              )}
            </div>
          </div>
          {/* The scroll affordance. Overlay scrollbars on macOS and iOS stay invisible until the operator is already scrolling, so without this a clipped profile list reads as a list that simply ends. Rendered conditionally rather than faded via opacity so a list that fits has no decoration over its first and last rows at all. */}
          {profilesEdges.top && (
            <div
              data-testid="side-nav-profiles-fade-top"
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 top-0 h-4 bg-gradient-to-b from-bg-elevated to-transparent"
            />
          )}
          {profilesEdges.bottom && (
            <div
              data-testid="side-nav-profiles-fade-bottom"
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-bg-elevated to-transparent"
            />
          )}
        </div>
      </Section>

      {accountItems.length > 0 && (
        <Section labelKey="nav.section.account" collapsed={collapsed} className="shrink-0">
          {accountItems.map((item) => (
            <Item key={item.to} item={item} accountId={accountId} collapsed={collapsed} />
          ))}
        </Section>
      )}

      {systemItems.length > 0 && (
        <Section labelKey="nav.section.system" collapsed={collapsed} className="shrink-0">
          {systemItems.map((item) => (
            <Item key={item.to} item={item} accountId={accountId} collapsed={collapsed} />
          ))}
        </Section>
      )}

      {/* `shrink-0`, not `mt-auto`: `mt-auto` pinned this to the end of the SCROLL CONTENT rather than the rail, so the one control that shrinks the sidebar was the first thing a long profile list pushed below the fold. The profiles section's `flex-1` now does the pushing-down that `mt-auto` was there for. */}
      <div className="shrink-0 border-t border-border py-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          data-testid="side-nav-toggle"
          className={cn(
            'flex min-h-11 w-full items-center gap-2.5 px-4 text-xs font-medium tracking-wider text-muted-fg uppercase hover:bg-surface-alt hover:text-fg',
            collapsed && 'justify-center px-0',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <>
              <PanelLeftClose className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{t('nav.collapse')}</span>
            </>
          )}
        </button>
      </div>
    </nav>
  );
}

function Section({
  labelKey,
  collapsed,
  className,
  children,
}: {
  labelKey: I18nKey;
  collapsed: boolean;
  /** Flex sizing for this section's slot in the rail: `shrink-0` to hold natural height, or the column sizing that lets the profile list absorb the leftover space. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('border-b border-border py-2', className)}>
      <div
        className={cn(
          'px-4 pb-1 text-[11px] font-semibold tracking-[0.14em] text-muted-fg uppercase',
          collapsed && 'sr-only',
        )}
      >
        {t(labelKey)}
      </div>
      {children}
    </div>
  );
}

function Item({
  item,
  accountId,
  collapsed,
}: {
  item: StaticItem;
  accountId: string;
  collapsed: boolean;
}) {
  const { to, labelKey, Icon, exact } = item;
  const params = to.includes('$accountId') ? { accountId } : undefined;
  return (
    <NavLink
      to={to}
      params={params}
      label={t(labelKey)}
      collapsed={collapsed}
      exact={exact}
      icon={<Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
    />
  );
}

/**
 * One sidebar row. Active route = 2px accent left rule + accent text on a
 * faint accent wash (the terminal "lit channel" treatment). Collapsed rows
 * shrink to the icon and surface the label as a tooltip.
 */
function NavLink({
  to,
  params,
  label,
  icon,
  collapsed,
  exact,
  dense = false,
}: {
  to: string;
  params?: Record<string, string> | undefined;
  label: string;
  icon: ReactNode;
  collapsed: boolean;
  exact?: boolean | undefined;
  /** A nested section row under an expanded profile: smaller type, same height. */
  dense?: boolean;
}) {
  const link = (
    <Link
      // Typed-route union covers every `to` this file passes; the cast keeps
      // the row component generic over static and param routes.
      to={to as '/'}
      {...(params ? { params } : {})}
      aria-label={label}
      activeOptions={{ exact: exact ?? false }}
      className={cn(
        'flex min-h-11 items-center gap-2.5 border-l-2 border-transparent px-3.5 text-sm text-muted-fg hover:bg-surface-alt hover:text-fg',
        dense && 'gap-2 px-2.5 text-[13px]',
        collapsed && 'justify-center px-0',
      )}
      activeProps={{
        className:
          'border-l-accent bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] font-medium text-accent',
      }}
    >
      {icon}
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Profile row. A real `<Link>`, not a button: this app is built around comparing
 * profiles, so cmd-click into a new tab, copy-link, and the hover URL preview
 * are worth more here than anywhere else in the nav — and a button offers none
 * of them. Active state comes from the router's `$profileId`, which is what
 * owns focus.
 *
 * Being lit and being the current page are separate claims, and only the second earns `aria-current`. The row stays lit on every section beneath the profile — that is what "which profile am I in" means — but it links to the profile OVERVIEW, so claiming `aria-current="page"` from a section page would announce it as the page it links away from. That is the same defect the breadcrumb replaced on the old Back link, and the router's default non-exact matching reintroduces it unless `activeOptions` says otherwise.
 *
 * @param label - The operator's name for the profile, shown as the row text and as the collapsed rail's tooltip.
 * @param accountId - Account owning the profile, needed to build the nested route.
 * @param profileId - The profile this row navigates to.
 * @param active - Whether the router is anywhere inside this profile, which lights the row and expands its sections. Deliberately broader than the router's own active state.
 * @param collapsed - Icon-rail mode: the label becomes a tooltip.
 * @param icon - The status dot, or a red shield when the kill switch is on.
 * @returns The row, wrapped in a tooltip when collapsed.
 */
function ProfileNavLink({
  label,
  accountId,
  profileId,
  icon,
  active,
  collapsed,
}: {
  label: string;
  accountId: string;
  profileId: string;
  icon: ReactNode;
  active: boolean;
  collapsed: boolean;
}) {
  const link = (
    <Link
      to="/accounts/$accountId/profiles/$profileId"
      params={{ accountId, profileId }}
      aria-label={label}
      // The router owns `aria-current` here, and exact is what makes it honest:
      // its default matching counts an ancestor as active, so a section page
      // would stamp "page" on this row. It emits the `page` token, which is what
      // every nav surface in the app now agrees on.
      activeOptions={{ exact: true }}
      className={cn(
        'flex min-h-11 w-full items-center gap-2.5 border-l-2 border-transparent px-3.5 text-left text-sm text-muted-fg hover:bg-surface-alt hover:text-fg',
        collapsed && 'justify-center px-0',
        active &&
          'border-l-accent bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] font-medium text-accent',
      )}
    >
      {icon}
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
