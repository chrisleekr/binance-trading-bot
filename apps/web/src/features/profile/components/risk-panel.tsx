// Risk controls panel: the daily-loss circuit breaker. Shows the live breaker
// status (today's realised P/L vs the limit, and a clear "entries paused" badge
// when tripped) and lets the operator set the daily loss limit. Mobile-first.
//
// The breaker only pauses NEW buys; open positions and their protective stops
// keep running. It self-clears at the next UTC midnight.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  RiskConfigSchema,
  toConfigJsonSchema,
  type ProfileDashboardResponse,
  type StoredRiskConfig,
} from '@app/contracts';

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
import { QuoteAssetProvider } from '@/shared/forms/quote-asset-context';
import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatMoneyAmount, formatSignedAmount } from '@/shared/lib/format';
import { formatClock } from '@/shared/lib/format-time';

// Shared by the pending placeholder and the loaded panel so the chrome the
// operator sees mid-load is the chrome they keep.
const RISK_PANEL_TITLE = 'Daily-loss circuit breaker';
const RISK_PANEL_DESCRIPTION =
  "Pauses new buys once today's realised loss reaches your limit. Open positions and their stops keep running, and it clears at the next UTC day.";

// The shared money formatters, not a local 2-dp round: a BTC-quoted profile can lose 0.0031 BTC in a day, and "-0.00 BTC" reads as "nothing happened". They still hold whole-unit values at 2 dp, so a USDT readout is unchanged.
const fmtMoney = (s: string, quote: string): string => `${formatMoneyAmount(s)} ${quote}`;
const fmtSigned = (s: string, quote: string): string => `${formatSignedAmount(s)} ${quote}`;

// The one phrase in the contract's field description that hand-waves the unit. Rewritten at render time with the profile's real quote asset; the contract string stays shared with the docs generator, so it cannot name a per-profile value itself.
const QUOTE_CURRENCY_PHRASE = 'your quote currency (e.g. USDT)';

/**
 * The risk config's JSON Schema with the daily-loss field's description naming `quoteAsset` instead of the generic "your quote currency (e.g. USDT)".
 *
 * A worked example in another asset is worse than none: an operator running a BTC-quoted profile reads "e.g. USDT" and sizes the limit as if it were dollars.
 *
 * @param schema - The JSON Schema produced from `RiskConfigSchema`.
 * @param quoteAsset - The profile's quote asset to substitute into the description.
 * @returns A shallow copy with the one description rewritten, or the input unchanged when the phrase is absent (the drift case the risk-panel suite alarms on).
 */
const withQuoteAsset = (
  schema: Record<string, unknown>,
  quoteAsset: string,
): Record<string, unknown> => {
  const properties = schema['properties'] as Record<string, Record<string, unknown>> | undefined;
  const field = properties?.['dailyLossLimitQuote'];
  const description = field?.['description'];
  if (typeof description !== 'string' || !description.includes(QUOTE_CURRENCY_PHRASE))
    return schema;
  return {
    ...schema,
    properties: {
      ...properties,
      dailyLossLimitQuote: {
        ...field,
        // Replacer function, not a bare string: `QuoteAsset` is only length-bounded and uppercased, so a ticker containing `$'` or `` $` `` would otherwise be read as a substitution pattern and splice the surrounding sentence into the unit.
        description: description.replace(QUOTE_CURRENCY_PHRASE, () => quoteAsset),
      },
    },
  };
};

/**
 * Quote-denominated ACCOUNT equity the breaker could draw down: cash in the profile's own quote asset plus the deployed cost basis of every position on the account sharing this profile's mode and quote asset. Account-wide, not profile-wide — the wallet is one Binance key pair shared by every profile on the account — so any copy naming this figure has to say "account".
 *
 * An asset missing from a PRESENT balance snapshot is genuinely zero: the writer overwrites the whole set from the authoritative `getAccount` view, so absence is evidence of a zero balance, not of ignorance. An EMPTY snapshot is the ignorant case (the cache lapsed or never landed), and only that reads as unknown.
 *
 * @param dash - The profile dashboard payload, or undefined while it is loading or failed.
 * @returns The equity, or `null` when nothing is known. Null is not zero: a limit is only reported unreachable on positive evidence.
 */
const equityQuote = (dash: ProfileDashboardResponse | undefined): number | null => {
  if (!dash) return null;
  if (dash.balances.length === 0) return null;
  // Binance keys balances by upper-case asset; `profiles.quote_asset` may be stored lower or mixed case by design, so both sides are folded before comparison.
  const quote = dash.quoteAsset.toUpperCase();
  const cash = dash.balances
    .filter((b) => b.asset.toUpperCase() === quote)
    .reduce((sum, b) => sum + Number(b.free) + Number(b.locked), 0);
  return cash + Number(dash.deployedQuote);
};

export function RiskPanel({ profileId }: { readonly profileId: string }): React.JSX.Element {
  const queryClient = useQueryClient();
  const timeZone = useTimezone();
  const query = useQuery(riskDashboardQueryOptions(profileId));
  // Shares the dashboard cache the profile screen already populates, so this is normally a warm read rather than a second network round trip.
  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
    staleTime: 5000,
  });
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  // Read before the loading guard because the schema memo is a hook: still null on the first render, which just leaves the contract's generic wording in place until the profile arrives.
  const quoteAssetForSchema = query.data?.quoteAsset ?? null;
  const schema = useMemo(() => {
    const base = toConfigJsonSchema(RiskConfigSchema);
    return quoteAssetForSchema ? withQuoteAsset(base, quoteAssetForSchema) : base;
  }, [quoteAssetForSchema]);

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

  // A breaker that can never trip is decorative, and "Armed" over it is a false assurance. What has to clear the bar is the loss STILL needed to trip, not the whole limit: the worker compares the day's cumulative realised P/L against the limit, and equity already reflects today's result. Comparing the raw limit against current equity double-counts that result, and gets it wrong precisely on the days the badge is actually read.
  // Unknown equity is NOT the unreachable case: the worker halts at this threshold whatever the browser knows, so a lapsed balance snapshot keeps saying Armed rather than casting doubt on a live safety control. Strict `>` because a limit exactly equal to equity is reachable.
  const equity = equityQuote(dashboard.data);
  // Loss still needed to trip, per the worker's `pnl <= -limit`: solving for the extra loss L gives `L >= limit + pnl`, with pnl SIGNED. A profitable day raises the bar, and equity on the other side of the comparison already includes that gain — clamping it away would understate the headroom and hide a limit that genuinely cannot be reached. A limit already breached yields `<= 0`, which never exceeds equity, so the badge correctly stays off the unreachable branch.
  const remainingToTrip =
    live.limitQuote === null ? null : Number(live.limitQuote) + Number(live.todayRealizedPnl);
  const limitExceedsEquity =
    equity !== null && remainingToTrip !== null && remainingToTrip > equity;

  const statusBadge = live.halted ? (
    <Badge variant="danger" data-testid="risk-paused-badge">
      Entries paused
    </Badge>
  ) : limitExceedsEquity ? (
    <Badge variant="warning" data-testid="risk-unreachable-badge">
      Limit above equity
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
                {live.limitQuote === null ? 'Off' : fmtMoney(live.limitQuote, quoteAsset)}
              </dd>
            </div>
          </dl>
          {live.halted ? (
            <p className="text-xs text-down" data-testid="risk-paused-detail">
              Daily loss limit hit — new buys are paused
              {resumeNote}. Open positions and their stops keep running.
            </p>
          ) : null}

          {limitExceedsEquity ? (
            <p className="text-xs text-warning" data-testid="risk-limit-warning">
              Another {fmtMoney(String(remainingToTrip), quoteAsset)} of loss would have to land
              today to reach this limit, which is more than the{' '}
              {fmtMoney(String(equity), quoteAsset)} this account holds — so the breaker would never
              trip. Nothing is blocked; lower the limit if you want it to actually stop trading.
            </p>
          ) : null}

          {/* The unit reaches the generated control itself: "0.01" means one thing on a USDT profile and something else entirely on a BTC-quoted one. */}
          <QuoteAssetProvider quoteAsset={quoteAsset}>
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
          </QuoteAssetProvider>
        </div>
      </Panel>
    </div>
  );
}
