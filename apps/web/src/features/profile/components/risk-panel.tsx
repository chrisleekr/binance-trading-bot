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
import { LoadingRows } from '@/shared/components/page-skeleton';
import { AutoForm } from '@/shared/forms';
import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import {
  patchRiskConfig,
  riskDashboardQueryKey,
  riskDashboardQueryOptions,
} from '@/features/profile/api/risk';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatClock } from '@/shared/lib/format-time';

// Shared by the pending placeholder and the loaded panel so the chrome the
// operator sees mid-load is the chrome they keep.
const RISK_PANEL_TITLE = 'Daily-loss circuit breaker';
const RISK_PANEL_DESCRIPTION =
  "Pauses new buys once today's realised loss reaches your limit. Open positions and their stops keep running, and it clears at the next UTC day.";

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
    // The panel chrome is what tells the operator this section exists at all;
    // dropping it mid-load made the whole control disappear off the page.
    return (
      <div className="space-y-6" data-testid="risk-panel">
        <Panel
          title={RISK_PANEL_TITLE}
          description={RISK_PANEL_DESCRIPTION}
          testId="risk-status-card"
        >
          {/* Realised-today and limit readouts, plus the limit field and its
              save row — four rows in the loaded body. */}
          <LoadingRows rows={4} />
        </Panel>
      </div>
    );
  }
  if (query.isError || !query.data) {
    return <p className="text-sm text-down">Could not load risk controls.</p>;
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
        <p className="text-xs text-warning" data-testid="risk-config-invalid">
          Your saved risk settings could not be read and are shown as defaults. Re-save to fix.
        </p>
      ) : null}

      {/* One panel: the live breaker status and the editable limit are the same
          control seen two ways, so they read as one section rather than a
          status box above a separate settings box. */}
      <Panel
        title={RISK_PANEL_TITLE}
        description={RISK_PANEL_DESCRIPTION}
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
              <dd className="font-medium text-fg" data-testid="risk-limit">
                {live.limitQuote === null
                  ? 'Off'
                  : `${Number(live.limitQuote).toFixed(2)} ${quoteAsset}`}
              </dd>
            </div>
          </dl>
          {live.halted ? (
            <p className="text-xs text-down" data-testid="risk-paused-detail">
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
            <FormActions className="items-center gap-3 border-t border-border pt-4">
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
