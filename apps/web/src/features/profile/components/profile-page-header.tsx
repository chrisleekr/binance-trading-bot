// Shared header for every profile management sub-page (strategy config, risk,
// live gate, discovery, notifications, backtest, history, bulk order,
// general). The page title + profile name, and the same status pill + Manage
// slide-over the dashboard overview carries — so the operator re-opens the
// operations menu from any page. Replaces the always-on horizontal section
// strip, which was too cramped to read on a narrow screen.
//
// Orientation is not this header's job: `PageHeader` renders the breadcrumb,
// which names every ancestor rather than offering one unnamed step back, and
// the sidebar lists the sibling sections.
//
// No Investigate trigger here. This header renders on nine sub-pages, and a
// diagnostic offered from the Discovery editor reads as "investigate discovery"
// when it always investigates the whole profile. It lives on the profile landing
// header, plus an entry in the Manage slide-over these pages already open.

import type { ReactNode } from 'react';

import { ProfileManageSheet } from '@/features/profile/components/profile-manage-sheet';
import { ProfileStatus } from '@/features/profile/components/profile-status';
import { PageHeader } from '@/shared/components/page';

export function ProfilePageHeader({
  profileId,
  title,
  description,
}: {
  readonly profileId: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
}): React.JSX.Element {
  return (
    <PageHeader
      title={title}
      // No `meta`: the breadcrumb directly above already names the profile, and
      // showing it twice in one header is noise, not reinforcement.
      description={description}
      actions={
        <>
          <ProfileStatus profileId={profileId} />
          <ProfileManageSheet profileId={profileId} />
        </>
      }
    />
  );
}
