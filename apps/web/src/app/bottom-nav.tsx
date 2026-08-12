import { Link } from '@tanstack/react-router';
import { Home, Settings } from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';

import { cn } from '@/shared/lib/cn';
import { t, type I18nKey } from '@/shared/lib/i18n';

interface NavItem {
  readonly to: '/' | '/settings';
  readonly labelKey: I18nKey;
  readonly Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', labelKey: 'nav.home', Icon: Home },
  { to: '/settings', labelKey: 'nav.settings', Icon: Settings },
];

export function BottomNav({
  className,
  demoMode = false,
}: {
  className?: string;
  // Live demo: hide Settings — it fronts the now-403 credential/backup routes.
  demoMode?: boolean;
}) {
  const items = demoMode ? NAV_ITEMS.filter((item) => item.to !== '/settings') : NAV_ITEMS;
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
      {items.map(({ to, labelKey, Icon }) => (
        <Link
          key={to}
          to={to}
          className="flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-1 border-t-2 border-transparent text-xs font-medium text-muted-fg hover:text-fg"
          activeProps={{ className: 'border-t-accent text-accent' }}
          activeOptions={{ exact: to === '/' }}
        >
          <Icon className="h-5 w-5" aria-hidden="true" />
          <span>{t(labelKey)}</span>
        </Link>
      ))}
    </nav>
  );
}
