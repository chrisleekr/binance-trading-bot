// Account-global operational alert toggles. Profile notifications (which events
// alert you) live per-profile on each profile's Notifications page; these are
// account-level ops events with no owning profile — a background job dying. Each
// toggle writes the whole map back, then refetches.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Panel } from '@/shared/components/panel';
import { Label } from '@/shared/components/ui/label';
import { Switch } from '@/shared/components/ui/switch';
import { ApiError } from '@/shared/lib/api';
import {
  fetchOpsNotify,
  opsNotifyQueryKey,
  updateOpsNotify,
} from '@/features/account/api/ops-notify';

import { ACCOUNT_NOTIFY_EVENT_CATALOG, type OpsNotifyConfig } from '@app/contracts';
import { LoadingRows } from '@/shared/components/page-skeleton';

/**
 * The ops-alert card. Owns the ops-config query and the patch mutation; renders
 * one labelled switch per account event category from the shared catalog, so
 * adding a category is a contracts-only change. Notifiers themselves are
 * configured per profile; this card needs at least one notifier somewhere to
 * have anywhere to send.
 */
export function OpsNotifyCard(): React.JSX.Element {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: opsNotifyQueryKey, queryFn: fetchOpsNotify });
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  const update = useMutation({
    mutationFn: (next: OpsNotifyConfig) => updateOpsNotify(next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: opsNotifyQueryKey }),
    onError: (err) =>
      setBanner({
        kind: 'err',
        message: err instanceof ApiError ? `${err.code}: ${err.message}` : 'unknown error',
      }),
  });

  const events = q.data;

  return (
    <Panel
      title="Operational alerts"
      description="Account-wide alerts that aren’t tied to one profile. They go to every notifier you’ve configured."
      testId="ops-notify-card"
    >
      <div className="space-y-3">
        {q.isLoading ? <LoadingRows /> : null}

        <ActionBanner banner={banner} />

        {events ? (
          <ul className="space-y-3">
            {ACCOUNT_NOTIFY_EVENT_CATALOG.map((meta) => (
              <li key={meta.category} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Label
                    htmlFor={`ops-event-${meta.category}`}
                    className="text-fg text-sm font-medium"
                  >
                    {meta.label}
                  </Label>
                  <p className="text-muted-fg text-xs">{meta.description}</p>
                </div>
                <Switch
                  id={`ops-event-${meta.category}`}
                  checked={events[meta.category]}
                  disabled={update.isPending}
                  data-testid={`ops-event-${meta.category}`}
                  onCheckedChange={(checked) =>
                    update.mutate({ ...events, [meta.category]: checked })
                  }
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
