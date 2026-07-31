// The profile management sections — the single source of truth for the grouped
// Manage menu (ProfileManageCard), the launcher into a profile's pages. `as
// const` preserves each `to` as a literal route path so TanStack Router's typed
// Link accepts it.
//
// `testId` keeps the menu's existing `profile-manage-<id>` hooks stable (note
// gate → live-gate, config → config — not slugs of the path). `icon` renders on
// the menu tiles.

import {
  Bell,
  FlaskConical,
  Gauge,
  History,
  ListPlus,
  Radar,
  Settings,
  Shield,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';

export interface ProfileSectionItem {
  readonly to: string;
  readonly label: string;
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
        label: 'Strategy',
        testId: 'config',
        icon: SlidersHorizontal,
      },
      {
        to: '/accounts/$accountId/profiles/$profileId/risk',
        label: 'Risk',
        testId: 'risk',
        icon: Shield,
      },
      {
        to: '/accounts/$accountId/profiles/$profileId/gate',
        label: 'Live gate',
        testId: 'live-gate',
        icon: Gauge,
      },
      {
        to: '/accounts/$accountId/profiles/$profileId/discovery',
        label: 'Discovery',
        testId: 'discovery',
        icon: Radar,
      },
      {
        to: '/accounts/$accountId/profiles/$profileId/notifications',
        label: 'Notifications',
        testId: 'notifications',
        icon: Bell,
      },
    ],
  },
  {
    group: 'Analyze',
    items: [
      {
        to: '/accounts/$accountId/profiles/$profileId/backtest',
        label: 'Backtest',
        testId: 'backtest',
        icon: FlaskConical,
      },
      {
        to: '/accounts/$accountId/profiles/$profileId/history',
        label: 'History',
        testId: 'history',
        icon: History,
      },
    ],
  },
  {
    group: 'Operate',
    items: [
      {
        to: '/accounts/$accountId/profiles/$profileId/bulk-order',
        label: 'Bulk order',
        testId: 'bulk-order',
        icon: ListPlus,
      },
    ],
  },
  {
    group: 'Profile',
    items: [
      {
        to: '/accounts/$accountId/profiles/$profileId/general',
        label: 'General',
        testId: 'general',
        icon: Settings,
      },
    ],
  },
] as const satisfies readonly ProfileSectionGroup[];
