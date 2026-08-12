// Emergency stop for ONE account. Confirm-gated: the dialog lists every profile
// of that account still trading, then fans the per-profile disable-all endpoint
// out to all of them. Failures stay listed so a half-stopped account is never
// silent. Stopping is account-wide; resuming stays a deliberate per-profile act.
//
// The account arrives as a prop, from the route that already names it. It used
// to read the ambient active-account and fall back to `''`, which silently
// disabled the control on any surface that had not set one.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OctagonX, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import { dashboardAggregateQueryOptions } from '@/features/dashboard/api/dashboard';
import { enableKillSwitch } from '@/features/profile/api/profile-dashboard';
import { Badge } from '@/shared/components/ui/badge';
import { FormActions } from '@/shared/components/form-actions';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip';
import { errorMessage } from '@/shared/lib/api';
import { cn } from '@/shared/lib/cn';
import { t } from '@/shared/lib/i18n';

import type { DashboardAggregateRow } from '@app/contracts';

export function AccountKillSwitch({
  accountId,
  className,
}: {
  readonly accountId: string;
  readonly className?: string;
}) {
  const { data } = useQuery(dashboardAggregateQueryOptions(accountId));
  const rows = data?.profiles ?? [];
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [failures, setFailures] = useState<
    readonly { profileId: string; name: string; message: string }[]
  >([]);
  const targets = rows.filter((r) => !r.killSwitch);

  const mutation = useMutation({
    mutationFn: async (profiles: readonly DashboardAggregateRow[]) => {
      const results = await Promise.allSettled(profiles.map((p) => enableKillSwitch(p.profileId)));
      return results.flatMap((res, i) => {
        const p = profiles[i];
        return res.status === 'rejected' && p
          ? [{ profileId: p.profileId, name: p.name, message: errorMessage(res.reason) }]
          : [];
      });
    },
    onSuccess: (failed) => {
      setFailures(failed);
      if (failed.length === 0) setOpen(false);
    },
    onSettled: () => {
      // Kill switch flips state the whole app reads (aggregate, profile
      // dashboards, symbol pages). A rare emergency action justifies the
      // blanket invalidation.
      void queryClient.invalidateQueries();
    },
  });

  if (rows.length === 0) return null;

  if (targets.length === 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="danger" data-testid="global-kill-all-stopped" className="gap-1">
            <ShieldAlert className="h-3 w-3" aria-hidden="true" />
            {t('topbar.kill.all_stopped')}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>{t('topbar.kill.resume_hint')}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <Button
        variant="destructive"
        data-testid="global-kill"
        onClick={() => {
          setFailures([]);
          setOpen(true);
        }}
        className={cn('gap-1.5', className)}
      >
        <OctagonX className="h-4 w-4" aria-hidden="true" />
        {t('topbar.kill.button')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="global-kill-dialog">
          <DialogHeader>
            <DialogTitle>{t('topbar.kill.title')}</DialogTitle>
            <DialogDescription>{t('topbar.kill.body')}</DialogDescription>
          </DialogHeader>
          <ul className="divide-y divide-border border border-border">
            {targets.map((p) => (
              <li
                key={p.profileId}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <span className="truncate">{p.name}</span>
                <Badge variant={p.binanceMode === 'live' ? 'danger' : 'outline'}>
                  {p.binanceMode === 'live' ? 'Live' : t('home.card.testnet')}
                </Badge>
              </li>
            ))}
          </ul>
          {failures.length > 0 ? (
            <ul className="space-y-1 text-sm text-danger" data-testid="global-kill-errors">
              {failures.map((f) => (
                <li key={f.profileId}>{t('topbar.kill.failed', { name: f.name })}</li>
              ))}
            </ul>
          ) : null}
          <FormActions>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t('topbar.kill.cancel')}
            </Button>
            <Button
              variant="destructive"
              data-testid="global-kill-confirm"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(targets)}
            >
              {t('topbar.kill.confirm')}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
