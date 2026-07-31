// Risk controls panel: the daily-loss circuit breaker. Shows the live breaker
// status (today's realised P/L vs the limit, and a clear "entries paused" badge
// when tripped) and lets the operator set the daily loss limit. Mobile-first.
//
// The breaker only pauses NEW buys; open positions and their protective stops
// keep running. It self-clears at the next UTC midnight.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { RiskConfigSchema, toConfigJsonSchema, type StoredRiskConfig } from '@app/contracts';

import { Badge } from '@/shared/components/ui/badge';
import { FormActions } from '@/shared/components/form-actions';
import { Button } from '@/shared/components/ui/button';
import { Panel } from '@/shared/components/panel';
import { AutoForm } from '@/shared/forms';
import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import {
  patchRiskConfig,
  riskDashboardQueryKey,
  riskDashboardQueryOptions,
} from '@/features/profile/api/risk';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatClock } from '@/shared/lib/format-time';

const fmtSigned = (s: string, quote: string): string => {
  const n = Number(s);
  if (!Number.isFinite(n)) return `${s} ${quote}`;
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)} ${quote}`;
};

export function RiskPanel({ profileId }: { readonly profileId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const timeZone = useTimezone();
  const query = useQuery(riskDashboardQueryOptions(profileId));
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  const schema = useMemo(() => toConfigJsonSchema(RiskConfigSchema), []);

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      patchRiskConfig(profileId, values as StoredRiskConfig),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Saved.' });
      await queryClient.invalidateQueries({ queryKey: riskDashboardQueryKey(profileId) });
    },
    onError: (e) =>
      setBanner({ kind: 'err', message: e instanceof Error ? e.message : 'save failed' }),
  });

  if (query.isPending) {
    return <p className="text-muted-fg text-sm">Loading risk controls…</p>;
  }
  if (query.isError || !query.data) {
    return <p className="text-down text-sm">Could not load risk controls.</p>;
  }

  const { config, configInvalid, quoteAsset, status: live } = query.data;

  // The breaker clears at the next UTC day; the operator reads it in their zone.
  const resumeNote =
    live.resetsAtMs !== null ? `, resuming ${formatClock(live.resetsAtMs, timeZone)}` : '';

  const statusBadge = live.halted ? (
    <Badge variant="danger" data-testid="risk-paused-badge">
      Entries paused
    </Badge>
  ) : live.limitQuote !== null ? (
    <Badge data-testid="risk-armed-badge">Armed</Badge>
  ) : (
    <Badge variant="secondary" data-testid="risk-off-badge">
      Off
    </Badge>
  );

  return (
    <div className="space-y-6" data-testid="risk-panel">
      {configInvalid ? (
        <p className="text-warning text-xs" data-testid="risk-config-invalid">
          Your saved risk settings could not be read and are shown as defaults. Re-save to fix.
        </p>
      ) : null}

      {/* One panel: the live breaker status and the editable limit are the same
          control seen two ways, so they read as one section rather than a
          status box above a separate settings box. */}
      <Panel
        title="Daily-loss circuit breaker"
        description="Pauses new buys once today's realised loss reaches your limit. Open positions and their stops keep running, and it clears at the next UTC day."
        actions={statusBadge}
        testId="risk-status-card"
      >
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-muted-fg">Realised today</dt>
              <dd
                className={`font-medium ${Number(live.todayRealizedPnl) >= 0 ? 'text-up' : 'text-down'}`}
                data-testid="risk-today-pnl"
              >
                {fmtSigned(live.todayRealizedPnl, quoteAsset)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-fg">Daily loss limit</dt>
              <dd className="text-fg font-medium" data-testid="risk-limit">
                {live.limitQuote === null
                  ? 'Off'
                  : `${Number(live.limitQuote).toFixed(2)} ${quoteAsset}`}
              </dd>
            </div>
          </dl>
          {live.halted ? (
            <p className="text-down text-xs" data-testid="risk-paused-detail">
              Daily loss limit hit — new buys are paused
              {resumeNote}. Open positions and their stops keep running.
            </p>
          ) : null}

          <AutoForm
            jsonSchema={schema}
            defaultValues={config}
            onSubmit={(v) => save.mutate(v)}
            submitError={save.error}
            groupLooseFields={false}
          >
            <ActionBanner banner={banner} />
            <FormActions className="border-border items-center gap-3 border-t pt-4">
              <Button type="submit" variant="default" disabled={save.isPending}>
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </FormActions>
          </AutoForm>
        </div>
      </Panel>
    </div>
  );
}
