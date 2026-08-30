// The profile management sections — the single source of truth for its three consumers: the sidebar's expanded profile, the mobile Profiles sheet, and the breadcrumb's section labels. `as const` preserves each `to` as a literal route path so TanStack Router's typed Link accepts it.
//
// Labels come from the same i18n keys the pages title themselves with, so a nav row and the `<h1>` it lands on cannot drift apart. They used to be hardcoded here and four of them had already diverged (Strategy/"Strategy config", Risk/"Risk controls", Bulk order/"Bulk manual order", General/"Profile settings").
//
// `icon` renders on every row; `group` orders them through NAV_GROUP_ORDER.

import {
  Bell,
  FlaskConical,
  Gauge,
  History,
  LayoutDashboard,
  ListPlus,
  Radar,
  Settings,
  Shield,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';

import { t } from '@/shared/lib/i18n';
import type { DemoVisible } from '@/shared/lib/demo-visibility';

export interface ProfileSectionItem extends DemoVisible {
  readonly to: string;
  readonly label: string;
  /** No `src/` consumer since the Manage menu's tiles went — it survives as the stable handle the ordering test names each section by, which is why it is not a slug of the path (gate → live-gate). */
  readonly testId: string;
  readonly icon: LucideIcon;
}
export interface ProfileSectionGroup {
  readonly group: string;
  readonly items: readonly ProfileSectionItem[];
}

export const PROFILE_SECTIONS = [
  {
    group: 'Configure',
    items: [
      {
        to: '/accounts/$accountId/profiles/$profileId/config',
        label: t('edit.profile_config.title'),
        testId: 'config',
        demoHidden: false,
        icon: SlidersHorizontal,
      },
      {
        to: '/accounts/$accountId/profiles/$profileId/risk',
        label: t('edit.risk.title'),
        testId: 'risk',
        demoHidden: false,
        icon: Shield,
      },
      {
        to: '/accounts/$accountId/profiles/$profileId/gate',
        label: t('edit.gate.title'),
        testId: 'live-gate',
        demoHidden: false,
        icon: Gauge,
      },
      {
        to: '/accounts/$accountId/profiles/$profileId/discovery',
        label: t('edit.discovery.title'),
        testId: 'discovery',
        demoHidden: false,
        icon: Radar,
      },
      {
        // The only demo-hidden section: it reads and writes notifier providers, whose routes 403 for the demo operator.
        to: '/accounts/$accountId/profiles/$profileId/notifications',
        label: t('edit.notifications.title'),
        testId: 'notifications',
        demoHidden: true,
        icon: Bell,
      },
    ],
  },
  {
    group: 'Analyze',
    items: [
      {
        to: '/accounts/$accountId/profiles/$profileId/backtest',
        label: t('nav.backtest'),
        testId: 'backtest',
        demoHidden: false,
        icon: FlaskConical,
      },
      {
        to: '/accounts/$accountId/profiles/$profileId/history',
        label: t('nav.history'),
        testId: 'history',
        demoHidden: false,
        icon: History,
      },
    ],
  },
  {
    group: 'Operate',
    items: [
      {
        to: '/accounts/$accountId/profiles/$profileId/bulk-order',
        label: t('edit.bulk_order.title'),
        testId: 'bulk-order',
        demoHidden: false,
        icon: ListPlus,
      },
    ],
  },
  {
    group: 'Profile',
    items: [
      {
        to: '/accounts/$accountId/profiles/$profileId/general',
        label: t('edit.general.title'),
        testId: 'general',
        demoHidden: false,
        icon: Settings,
      },
    ],
  },
] as const satisfies readonly ProfileSectionGroup[];

/**
 * The profile's own landing page. Not part of PROFILE_SECTIONS because it is not a section: it is the page the sections hang off, so the breadcrumb names its rung from the profile's own name rather than from this label. The navs do list it, first, so they prepend this.
 */
const PROFILE_OVERVIEW_ITEM = {
  to: '/accounts/$accountId/profiles/$profileId',
  label: t('nav.overview'),
  testId: 'overview',
  demoHidden: false,
  icon: LayoutDashboard,
} as const satisfies ProfileSectionItem;

/** Every route path a profile nav row can point at, so `PROFILE_NAV_ITEMS` keeps literal `to` values that TanStack's typed `Link` accepts. */
export type ProfileSectionTo =
  (typeof PROFILE_SECTIONS)[number]['items'][number]['to'] | (typeof PROFILE_OVERVIEW_ITEM)['to'];

/** A nav row: a section item narrowed to the literal `to` union. */
export interface ProfileNavItem extends DemoVisible {
  readonly to: ProfileSectionTo;
  readonly label: string;
  readonly testId: string;
  readonly icon: LucideIcon;
}

/**
 * Group order for the navs, which read as one list rather than a grid: the two analysis pages sit next to Overview because they answer "how is it doing", then the settings pages. PROFILE_SECTIONS keeps its own authoring order, which this deliberately does not follow.
 *
 * Sorted by this list rather than filtered through it: a group renamed here without updating the order would then sort last, not vanish. A filter would have dropped it silently.
 */
export const NAV_GROUP_ORDER: readonly string[] = ['Analyze', 'Configure', 'Operate', 'Profile'];

const rank = (group: string): number => {
  const i = NAV_GROUP_ORDER.indexOf(group);
  return i === -1 ? NAV_GROUP_ORDER.length : i;
};

/**
 * Every profile destination in reading order, for the two surfaces that present the profile as a place: the sidebar's expanded profile and the mobile Profiles sheet. Overview first, then the groups in NAV_GROUP_ORDER. Also keyed by PROFILE_SECTION_LABELS for the breadcrumb.
 */
export const PROFILE_NAV_ITEMS: readonly ProfileNavItem[] = [
  PROFILE_OVERVIEW_ITEM,
  ...[...PROFILE_SECTIONS]
    .sort((a, b) => rank(a.group) - rank(b.group))
    .flatMap((g): readonly ProfileNavItem[] => g.items),
];

/** Route path -> nav label, so a breadcrumb names a section exactly as the navs do. */
export const PROFILE_SECTION_LABELS: ReadonlyMap<string, string> = new Map(
  PROFILE_NAV_ITEMS.map((i) => [i.to, i.label]),
);
