// Profile Manage menu — the launcher into a profile's management pages, shown in
// the Manage slide-over. Pure navigation, grouped (Configure / Analyze / Operate
// / Profile). The lifecycle and admin actions (enable/disable, the per-profile
// stop, rename, quote, delete, API key) moved to the General page
// (profile-general-panel.tsx); the only inline action left is the operational
// Reconcile fees mutation. Sections come from the shared PROFILE_SECTIONS.

import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Receipt } from 'lucide-react';
import { toast } from 'sonner';

import { reconcileProfileFees } from '@/features/profile/api/profiles-mutations';
import { PROFILE_SECTIONS } from '@/features/profile/lib/profile-sections';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { Button } from '@/shared/components/ui/button';

const tileClass =
  'border-border text-fg hover:bg-bg-elevated flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm';

export function ProfileManageCard({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element {
  const accountId = useActiveAccountId() ?? '';
  // Backfill real Binance commission into the trade archive so net-of-fee P/L is
  // honest. Fire-and-forget worker job; the result shows on the next History read.
  const reconcileFees = useMutation({
    mutationFn: () => reconcileProfileFees(profileId),
    onSuccess: () =>
      toast.success('Reconciling fees from Binance — check History again in a moment.'),
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not start fee reconciliation.'),
  });

  return (
    <div className="space-y-5" data-testid="profile-manage-card">
      {PROFILE_SECTIONS.map((g) => (
        <div key={g.group} className="space-y-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-fg uppercase">{g.group}</h3>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
            {g.items.map((it) => {
              const Icon = it.icon;
              return (
                <Link
                  key={it.to}
                  to={it.to}
                  params={{ accountId, profileId }}
                  className={tileClass}
                  data-testid={`profile-manage-${it.testId}`}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{it.label}</span>
                </Link>
              );
            })}
            {g.group === 'Operate' ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 justify-start gap-2"
                data-testid="profile-manage-reconcile-fees"
                onClick={() => reconcileFees.mutate()}
              >
                <Receipt className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">Reconcile fees</span>
              </Button>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
