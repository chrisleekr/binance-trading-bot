import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
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
import { useState, type ComponentType, type ReactNode, type SVGProps } from 'react';

import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip';
import { cn } from '@/shared/lib/cn';
import { t, type I18nKey } from '@/shared/lib/i18n';

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

interface StaticItem {
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

const MONITOR_ITEMS: readonly StaticItem[] = [
  { to: '/accounts/$accountId', labelKey: 'nav.home', Icon: Home, exact: true },
];

// Account-scoped destinations. These act on ONE account's wallet and order book,
// and the sidebar knows which: `accountId` comes from the URL via
// `useActiveAccountId`, and `Item` substitutes it. Top-level rather than nested
// under account settings, because these are the pages the operator reaches for
// when something has gone wrong on the exchange, and they should be one click away.
const ACCOUNT_ITEMS: readonly StaticItem[] = [
  {
    to: '/accounts/$accountId/settings',
    labelKey: 'nav.manage_account',
    Icon: Wallet,
    exact: true,
  },
  { to: '/accounts/$accountId/dust-transfer', labelKey: 'nav.dust_transfer', Icon: Coins },
  { to: '/accounts/$accountId/orphan-orders', labelKey: 'nav.orphan_orders', Icon: Unlink },
];

// Operator-global only: these belong to no single account.
const SYSTEM_ITEMS: readonly StaticItem[] = [
  { to: '/settings', labelKey: 'nav.settings', Icon: Settings, exact: true },
  { to: '/settings/backup-restore', labelKey: 'nav.backup_restore', Icon: HardDrive },
];

/**
 * Desktop-only collapsible left sidebar (v2 terminal chrome). Global
 * destinations under uppercase section labels, plus a live profile list so
 * any profile is one click away. Collapses to an icon rail; the choice
 * persists in localStorage. Mobile keeps the BottomNav — this never renders
 * below `md`.
 */
export function SideNav({
  className,
  demoMode = false,
}: {
  className?: string;
  // Live demo: hide the entry points to the now-403 credential/backup routes —
  // the whole System section plus account settings (which hosts api-keys).
  demoMode?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const accountId = useActiveAccountId() ?? '';
  const routeProfileId = useParams({ strict: false }).profileId ?? null;
  const { data } = useQuery({
    ...dashboardAggregateQueryOptions(accountId),
    enabled: accountId !== '',
  });
  const profiles = data?.profiles ?? [];
  const navigate = useNavigate();

  // A profile row focuses the overview on that profile and lands on the
  // account-nested profile route. The URL now owns focus.
  const focusProfile = (profileId: string): void => {
    void navigate({
      to: '/accounts/$accountId/profiles/$profileId',
      params: { accountId, profileId },
    });
  };

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
      className={cn(
        'border-border bg-bg-elevated shrink-0 flex-col overflow-y-auto border-r',
        collapsed ? 'w-[52px]' : 'w-52',
        className,
      )}
    >
      <Section labelKey="nav.section.monitor" collapsed={collapsed}>
        {MONITOR_ITEMS.map((item) => (
          <Item key={item.to} item={item} accountId={accountId} collapsed={collapsed} />
        ))}
      </Section>

      <Section labelKey="nav.section.profiles" collapsed={collapsed}>
        {profiles.map((p) => {
          const dot = profileDot(p);
          return (
            <ProfileNavButton
              key={p.profileId}
              label={p.name}
              active={routeProfileId === p.profileId}
              collapsed={collapsed}
              onSelect={() => focusProfile(p.profileId)}
              icon={
                p.killSwitch ? (
                  <ShieldAlert className="text-danger h-4 w-4 shrink-0" aria-hidden="true" />
                ) : (
                  <span
                    className={cn('mx-1 inline-block h-2 w-2 shrink-0 rounded-full', dot.cls)}
                    title={dot.label}
                    aria-hidden="true"
                  />
                )
              }
            />
          );
        })}
        <Item
          item={{
            to: '/accounts/$accountId/profiles/new',
            labelKey: 'nav.new_profile',
            Icon: Plus,
          }}
          accountId={accountId}
          collapsed={collapsed}
        />
      </Section>

      <Section labelKey="nav.section.account" collapsed={collapsed}>
        {(demoMode
          ? ACCOUNT_ITEMS.filter((item) => item.to !== '/accounts/$accountId/settings')
          : ACCOUNT_ITEMS
        ).map((item) => (
          <Item key={item.to} item={item} accountId={accountId} collapsed={collapsed} />
        ))}
      </Section>

      {!demoMode && (
        <Section labelKey="nav.section.system" collapsed={collapsed}>
          {SYSTEM_ITEMS.map((item) => (
            <Item key={item.to} item={item} accountId={accountId} collapsed={collapsed} />
          ))}
        </Section>
      )}

      <div className="border-border mt-auto border-t py-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          data-testid="side-nav-toggle"
          className={cn(
            'text-muted-fg hover:bg-surface-alt hover:text-fg flex min-h-11 w-full items-center gap-2.5 px-4 text-xs font-medium uppercase tracking-wider',
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
  children,
}: {
  labelKey: I18nKey;
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <div className="border-border border-b py-2">
      <div
        className={cn(
          'text-muted-fg px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em]',
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
}: {
  to: string;
  params?: Record<string, string> | undefined;
  label: string;
  icon: ReactNode;
  collapsed: boolean;
  exact?: boolean | undefined;
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
        'text-muted-fg hover:bg-surface-alt hover:text-fg flex min-h-10 items-center gap-2.5 border-l-2 border-transparent px-3.5 text-sm',
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
 * Profile row. Unlike a route NavLink, selecting a profile sets the overview
 * scope and navigates to `/` (the standalone profile page is retired), so the
 * active treatment is driven by the scope match, not the router.
 */
function ProfileNavButton({
  label,
  icon,
  active,
  collapsed,
  onSelect,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  collapsed: boolean;
  onSelect: () => void;
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'text-muted-fg hover:bg-surface-alt hover:text-fg flex min-h-10 w-full items-center gap-2.5 border-l-2 border-transparent px-3.5 text-left text-sm',
        collapsed && 'justify-center px-0',
        active &&
          'border-l-accent text-accent bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] font-medium',
      )}
    >
      {icon}
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  );

  if (!collapsed) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
