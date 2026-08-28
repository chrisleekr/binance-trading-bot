// Profile Manage menu — the operations panel in the Manage slide-over.
//
// It holds only what has no page of its own: Investigate and Reconcile fees, both ACTIONS rather than routes. The navigation tiles it used to carry duplicated the sidebar's expanded profile and the mobile Profiles sheet, and lost to both: a modal can say where to go but never where you are among the siblings, which is the question an operator moving between two settings is actually asking.

import { useMutation } from '@tanstack/react-query';
import { Receipt, Stethoscope } from 'lucide-react';
import { toast } from 'sonner';

import { useDemoMode } from '@/features/auth/api/auth';
import { reconcileProfileFees } from '@/features/profile/api/profiles-mutations';
import { Button } from '@/shared/components/ui/button';
import { t } from '@/shared/lib/i18n';

export function ProfileManageCard({
  profileId,
  onInvestigate,
}: {
  readonly profileId: string;
  /** Hands the screen over to the investigation drawer; the caller closes this one. */
  readonly onInvestigate: () => void;
}): React.JSX.Element {
  // Enqueues a weighted Binance `myTrades` pull with no jobId dedup, so the route 403s for the demo operator. Investigate keeps its button because its drawer can explain itself; this one has nowhere to say so but here.
  const demoMode = useDemoMode();
  // Retry incomplete Binance fee evidence in the background; History remains unavailable where the required valuation cannot be proven.
  const reconcileFees = useMutation({
    mutationFn: () => reconcileProfileFees(profileId),
    onSuccess: () =>
      toast.success('Reconciling fees from Binance — check History again in a moment.'),
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not start fee reconciliation.'),
  });

  return (
    <div className="space-y-2" data-testid="profile-manage-card">
      <Button
        type="button"
        variant="outline"
        className="min-h-11 w-full justify-start gap-2"
        data-testid="profile-manage-investigate"
        onClick={onInvestigate}
      >
        <Stethoscope className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">Investigate</span>
      </Button>
      {demoMode ? (
        <p className="text-sm text-muted-fg" data-testid="reconcile-fees-demo-unavailable">
          {t('demo.reconcile_fees_unavailable')}
        </p>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full justify-start gap-2"
          data-testid="profile-manage-reconcile-fees"
          onClick={() => reconcileFees.mutate()}
        >
          <Receipt className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="truncate">Reconcile fees</span>
        </Button>
      )}
    </div>
  );
}
