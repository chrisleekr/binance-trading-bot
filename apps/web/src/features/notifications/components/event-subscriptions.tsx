// Per-profile notification event subscriptions. Sits above the provider editors
// in the notifications panel: the providers decide WHERE alerts go (Slack,
// Telegram, webhook); this decides WHICH events fire. Each toggle writes the
// whole notify_events map back via PATCH /profiles/:id (a partial map would
// reset the untouched categories to their defaults), then refetches the profile.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Panel } from '@/shared/components/panel';
import { Label } from '@/shared/components/ui/label';
import { Switch } from '@/shared/components/ui/switch';
import { ApiError } from '@/shared/lib/api';
import { fetchProfile, patchProfile, profileQueryKey } from '@/features/profile/api/profile';

import { PROFILE_NOTIFY_EVENT_CATALOG, type ProfileNotifyEvents } from '@app/contracts';
import { LoadingRows } from '@/shared/components/page-skeleton';

/**
 * The subscription section. Self-contained: owns the profile query (for the
 * current map) and the patch mutation. Renders one labelled switch per event
 * category from the shared catalog, so adding a category is a contracts-only
 * change.
 */
export function EventSubscriptions({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const queryKey = profileQueryKey(profileId);
  const profile = useQuery({ queryKey, queryFn: () => fetchProfile(profileId) });
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  const update = useMutation({
    mutationFn: (next: ProfileNotifyEvents) => patchProfile(profileId, { notifyEvents: next }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (err) =>
      setBanner({
        kind: 'err',
        message: err instanceof ApiError ? `${err.code}: ${err.message}` : 'unknown error',
      }),
  });

  const events = profile.data?.notifyEvents;

  return (
    <Panel
      title="Which events alert you"
      description="Choose the events that send a notification. Capital-safety alerts are on by default."
      testId="event-subscriptions"
    >
      <div className="space-y-3">
        {profile.isLoading ? <LoadingRows /> : null}

        <ActionBanner banner={banner} />

        {events ? (
          <ul className="space-y-3">
            {PROFILE_NOTIFY_EVENT_CATALOG.map((meta) => (
              <li key={meta.category} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Label htmlFor={`event-${meta.category}`} className="text-fg text-sm font-medium">
                    {meta.label}
                  </Label>
                  <p className="text-muted-fg text-xs">{meta.description}</p>
                </div>
                <Switch
                  id={`event-${meta.category}`}
                  checked={events[meta.category]}
                  disabled={update.isPending}
                  data-testid={`event-${meta.category}`}
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
