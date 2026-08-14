// Shared header for every profile management sub-page (strategy config, risk,
// live gate, discovery, notifications, backtest, history, bulk order,
// general). One Back link, the page title + profile name, and the same status
// pill + Manage slide-over the dashboard overview carries — so the operator
// re-opens the section menu from any page. Replaces the always-on horizontal
// section strip, which was too cramped to read on a narrow screen.
//
// Back goes up ONE level, to the profile these pages belong to — not home. It
// used to point at `/`, which both threw away the account in the URL and left
// the operator two navigations away from the page they came from.
//
// No Investigate trigger here. This header renders on nine sub-pages, and a
// diagnostic offered from the Discovery editor reads as "investigate discovery"
// when it always investigates the whole profile. It lives on the profile landing
// header, plus an entry in the Manage slide-over these pages already open.

import type { ReactNode } from 'react';

import { ProfileManageSheet } from '@/features/profile/components/profile-manage-sheet';
import { ProfileStatus } from '@/features/profile/components/profile-status';
import { useProfileName } from '@/features/profile/lib/use-profile-name';
import { BackLink, PageHeader } from '@/shared/components/page';
import { useActiveAccountId } from '@/shared/lib/account-scope';

export function ProfilePageHeader({
  profileId,
  title,
  description,
}: {
  readonly profileId: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
}): React.JSX.Element {
  const accountId = useActiveAccountId() ?? '';
  return (
    <PageHeader
      title={title}
      meta={useProfileName(profileId)}
      description={description}
      back={
        <BackLink to="/accounts/$accountId/profiles/$profileId" params={{ accountId, profileId }} />
      }
      actions={
        <>
          <ProfileStatus profileId={profileId} />
          <ProfileManageSheet profileId={profileId} />
        </>
      }
    />
  );
}
