// The phone's primary navigation. Four destinations mirroring the sidebar's own sections, because two static links exposed 2 of the app's 22 pages: every profile, every profile section, and every account-level page were unreachable from navigation below `md`.
//
// `Profiles` is a sheet rather than a route: profiles are a list, not a page, and the sheet is what lets the phone reach a profile's sections in two taps.

import { Link } from '@tanstack/react-router';
import { Home, Layers, Settings, Wallet } from 'lucide-react';
import { Fragment, type ComponentType, type SVGProps } from 'react';

import { MobileProfilesSheet } from '@/app/mobile-profiles-sheet';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { cn } from '@/shared/lib/cn';
import { visibleInDemo, type DemoVisible } from '@/shared/lib/demo-visibility';
import { t, type I18nKey } from '@/shared/lib/i18n';

interface NavItem extends DemoVisible {
  readonly to: '/' | '/settings' | '/accounts/$accountId/settings';
  readonly labelKey: I18nKey;
  readonly Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', labelKey: 'nav.home', Icon: Home, demoHidden: false },
  // Account-scoped: the hub page that fronts api-key, dust transfer, and
  // orphan orders, none of which the phone could reach before. Hidden in the
  // demo: api-key is a credential surface.
  { to: '/accounts/$accountId/settings', labelKey: 'nav.account', Icon: Wallet, demoHidden: true },
  { to: '/settings', labelKey: 'nav.settings', Icon: Settings, demoHidden: true },
];

// min-h-11/min-w-11 on every cell: 44x44 is the smallest reliable touch target,
// and the bar is the only navigation a phone has.
const CELL =
  'flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-1 border-t-2 border-transparent text-xs font-medium text-muted-fg hover:text-fg';

/**
 * The phone's primary navigation bar, hidden at `md` and above where the SideNav takes over. Renders every entry in NAV_ITEMS in order, with the Profiles sheet injected after Home so a profile's sections are two taps away.
 *
 * Every cell comes from the registry rather than being hand-placed, so a cell's label, icon, and destination cannot disagree: the previous shape read the first cell's destination by array position out of the demo-filtered list while hard-coding its label and icon, which meant filtering Home would have pointed a control still labelled "Home" at whatever survived first.
 *
 * @param className - Extra classes for the bar, used by the shell to hide it above `md`.
 * @param demoMode - Public live demo: drops every cell whose registry entry declared itself demo-hidden, and is passed on to the Profiles sheet so its profile sections are filtered the same way.
 * @returns The bottom bar.
 */
export function BottomNav({
  className,
  demoMode = false,
}: {
  className?: string;
  demoMode?: boolean;
}) {
  const activeAccountId = useActiveAccountId();
  const accountId = activeAccountId ?? '';
  const items = NAV_ITEMS.filter((item) => {
    if (!visibleInDemo(item, demoMode)) return false;
    // Without an account the nested path interpolates to `/accounts//settings`, which matches no route and lands the operator on not-found from the phone's primary bar.
    return item.to !== '/accounts/$accountId/settings' || activeAccountId !== null;
  });
  return (
    <nav
      aria-label="Primary"
      // pb-[env(safe-area-inset-bottom)] keeps tap targets above the iOS
      // home indicator on devices that report a non-zero bottom inset.
      // The h-16 sets the bar's chrome height; the inset adds on below.
      className={cn(
        'flex h-16 w-full items-stretch justify-around border-t border-border bg-bg-elevated pb-[env(safe-area-inset-bottom)]',
        className,
      )}
    >
      {items.map(({ to, labelKey, Icon }, i) => (
        <Fragment key={to}>
          <Link
            to={to}
            {...(to.includes('$accountId') ? { params: { accountId } } : {})}
            className={CELL}
            activeProps={{ className: 'border-t-accent text-accent' }}
            activeOptions={{ exact: true }}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
            <span>{t(labelKey)}</span>
          </Link>
          {/* Sits after Home so the bar reads Home | Profiles | Account | Settings. */}
          {i === 0 && (
            <MobileProfilesSheet
              demoMode={demoMode}
              trigger={
                <button type="button" className={CELL} data-testid="bottom-nav-profiles">
                  <Layers className="h-5 w-5" aria-hidden="true" />
                  <span>{t('nav.profiles')}</span>
                </button>
              }
            />
          )}
        </Fragment>
      ))}
    </nav>
  );
}
