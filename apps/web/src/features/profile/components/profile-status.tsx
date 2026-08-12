// Per-profile status line for the scoped overview's PROFILE section: the
// enabled/disabled pill and the notifier-gap warning dot. This used to be a
// detached chip in the top bar; here it sits where the profile is the subject
// and can be read in context. Read-only — toggling enabled lives in the Manage
// card.

import { useQuery } from '@tanstack/react-query';

import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import { cn } from '@/shared/lib/cn';
import { t } from '@/shared/lib/i18n';

export function ProfileStatus({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element | null {
  const accountId = useActiveAccountId() ?? '';
  const aggregate = useQuery({
    ...dashboardAggregateQueryOptions(accountId),
    enabled: accountId !== '',
  });
  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
  });

  const row = aggregate.data?.profiles.find((p) => p.profileId === profileId);
  if (!row) return null;

  const notifierGap =
    row.binanceMode === 'live' && (dashboard.data?.enabledNotifierCount ?? 1) === 0;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="profile-status">
      {/* Status pill, control-height to pair with the Manage button beside it. A
          coloured dot (green running / red stopped) reads the on/off state at a
          glance, ahead of the word. */}
      <span
        data-testid="profile-status-state"
        data-enabled={row.enabled}
        className="inline-flex h-9 items-center gap-2 rounded-sm border border-border-strong px-3 text-xs font-semibold tracking-wide text-fg uppercase"
      >
        <span
          aria-hidden
          className={cn('h-2 w-2 shrink-0 rounded-full', row.enabled ? 'bg-success' : 'bg-danger')}
        />
        {row.enabled ? t('home.card.enabled') : t('home.card.disabled')}
      </span>
      {notifierGap ? (
        <span
          data-testid="profile-status-notifier-gap"
          title={t('profile.controls.notifier_gap')}
          aria-label={t('profile.controls.notifier_gap')}
          className="h-2 w-2 shrink-0 rounded-full bg-warning"
        />
      ) : null}
    </div>
  );
}
