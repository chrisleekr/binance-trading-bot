// Profile strategy config editor + strategy switch, decoupled from any route so
// it can render inside the dashboard edit drawer ("edit config where you already
// are"). Owns its own queries and save/swap mutations; the host only supplies
// the profileId.
//
// The editor is a generated form. The API ships each strategy's config
// schema as JSON Schema in the strategy descriptor; `AutoForm` renders typed
// fields and validates input client-side against that schema. The
// server re-validates the submitted config against the strategy's own zod
// schema, so a bad shape still returns 422 and is surfaced in the banner.
//
// Switching strategy is a separate flow that opens a confirm modal: the
// `POST /switch-strategy` endpoint resets state and auto-pauses the
// profile, so the modal makes the irreversible nature of "state is
// reset, persistent records (orders, archive) are preserved" explicit
// before the operator commits.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Panel } from '@/shared/components/panel';
import { AutoForm, FormEquityProvider, type FormEquity } from '@/shared/forms';
import { errorMessage } from '@/shared/lib/api';
import { notifySaveDiagnostics } from '@/shared/lib/save-diagnostics';
import { ForceSellGuardNudge } from '@/features/symbol/components/force-sell-guard-nudge';
import { ConfigDiagnostics } from '@/features/profile/components/config-diagnostics';
import { fetchProfile, patchProfile, profileQueryKey } from '@/features/profile/api/profile';
import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import { strategiesQueryOptions } from '@/features/profile/api/strategies';
import { useStrategyDescriptor } from '@/shared/hooks/use-strategy-descriptor';
import { switchStrategy } from '@/features/profile/api/strategy-switch';
import { StrategyPreviewPanel } from '@/features/symbol/preview/strategy-preview-panel';
import {
  accountWireFromBalances,
  filtersFromExchangeInfoSymbol,
} from '@/features/symbol/preview/account-wire';
import { fetchExchangeInfo } from '@/features/symbol/api/exchange-info';
import { queryDefaults } from '@/shared/lib/query-client';
import { PanelStackSkeleton } from '@/shared/components/page-skeleton';

/**
 * Self-contained profile-config editor. Renders the load/error/ready states for
 * the profile and the strategy schema, then the generated config form, a
 * strategy selector with switch-confirm modal, and the save mutation banner.
 */
export function ProfileConfigPanel({
  profileId,
}: {
  readonly profileId: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const queryKey = profileQueryKey(profileId);

  const profile = useQuery({
    queryKey,
    queryFn: () => fetchProfile(profileId),
  });
  const strategies = useQuery(strategiesQueryOptions);

  // Live price for the configured symbol, used only to prefill the ladder
  // preview's hypothetical-entry input. Shares the dashboard cache/TTL the
  // profile screen already populates, so this is usually a warm read.
  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
    staleTime: 5000,
    // Poll so the ladder preview's default entry tracks the live price (the
    // server caches the payload for 5s, so this matches the source cadence).
    refetchInterval: 5000,
  });
  // Sizing filters for a single-symbol profile's bound symbol, so the preview can
  // size a concrete entry quantity. Shares the picker's 5-minute cache.
  const exchangeInfo = useQuery({ ...queryDefaults.exchangeInfo(), queryFn: fetchExchangeInfo });

  const [pendingStrategy, setPendingStrategy] = useState<string | null>(null);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  const save = useMutation({
    mutationFn: (config: unknown) => patchProfile(profileId, { config }),
    onSuccess: async (saved) => {
      setBanner({ kind: 'ok', message: 'Config saved.' });
      notifySaveDiagnostics(saved.diagnostics);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  const swap = useMutation({
    mutationFn: (key: string) => {
      const [name, version] = key.split('@');
      if (!name || !version) throw new Error('invalid strategy key');
      const strategy = strategies.data?.find((s) => s.name === name && s.version === version);
      if (!strategy) throw new Error('strategy not in registry');
      // Server runs `plugin.initialState(config)`; we send {} so the
      // operator gets the strategy's defaults rather than carrying the
      // old strategy's config across.
      return switchStrategy(profileId, {
        strategyName: name,
        strategyVersion: version,
        config: {},
      });
    },
    onSuccess: async (data) => {
      setBanner({
        kind: 'ok',
        message: `Switched to ${data.strategyName}@${data.strategyVersion}.`,
      });
      setPendingStrategy(null);
      await queryClient.invalidateQueries({ queryKey });
      await queryClient.invalidateQueries({ queryKey: profileDashboardQueryKey(profileId) });
    },
    onError: (err) => {
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  const currentKey =
    profile.data !== undefined
      ? `${profile.data.strategyName}@${profile.data.strategyVersion}`
      : '';
  // Resolve the current profile's schema by name only: the descriptor list
  // carries one entry per live plugin, so a profile pinned to a since-bumped
  // strategy_version must still render its config form (version is diagnostic,
  // not a lookup key, mirroring the server's describeForProfile).
  const descriptor = useStrategyDescriptor(profileId);

  // Strategy-provided live config preview (trailing-trade: the buy/sell ladder),
  // resolved through the view registry so the generic config route never names a
  // strategy. Undefined for strategies that ship no preview — the form then
  // renders full width with no side panel.
  //
  // The profile config is not symbol-scoped, so bind the preview's per-symbol
  // bits (regime verdict, live-price prefill) to the profile's symbol only when
  // it trades exactly one — a single regime verdict is ill-defined across many
  // symbols. With 0 or >1 the symbol stays undefined and the preview falls back
  // to the symbol-independent ladder; the per-symbol regime preview lives on the
  // symbol screen's config drawer, where a symbol is always in context.
  const boundSymbol = dashboard.data?.symbols.length === 1 ? dashboard.data.symbols[0] : undefined;
  const previewPrice = boundSymbol?.currentPrice ?? null;
  const filters = useMemo(
    () =>
      boundSymbol
        ? filtersFromExchangeInfoSymbol(
            exchangeInfo.data?.symbols.find((s) => s.symbol === boundSymbol.symbol),
          )
        : undefined,
    [exchangeInfo.data, boundSymbol],
  );

  // Account equity for the entry-sizing widget's percent-of-account preview:
  // quote cash (free + locked of the profile's quote asset) + deployed
  // cost-basis across the account. Mirrors the equity the strategy resolves at
  // tick time, so the "≈ N USDT" the operator sees matches what a percent entry
  // would actually spend. Display-only Number math (apps/web bars decimal.js).
  const dash = dashboard.data;
  const equity: FormEquity | null = dash
    ? {
        quoteAsset: dash.quoteAsset,
        equityQuote:
          dash.balances
            .filter((b) => b.asset === dash.quoteAsset)
            .reduce((sum, b) => sum + Number(b.free) + Number(b.locked), 0) +
          Number(dash.deployedQuote),
      }
    : null;
  // Wire account for the preview's percent-of-account / free-cash sizing: the
  // profile's string balances plus the account-wide deployed cost-basis.
  const account = dash ? accountWireFromBalances(dash.balances, dash.deployedQuote) : undefined;

  return (
    <div className="space-y-6" data-testid="profile-config-panel">
      {/* Shape mirrors what lands here: strategy picker, diagnostics, then the
          generated config form's groups. */}
      {profile.isLoading ? <PanelStackSkeleton shape={[1, 3, 5, 4]} /> : null}

      {profile.error ? (
        <Alert variant="danger">
          <AlertTitle>Failed to load profile</AlertTitle>
          <AlertDescription>
            {profile.error instanceof Error ? profile.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      {profile.isSuccess ? (
        <>
          <Panel
            title="Strategy"
            description="Which packaged strategy this profile runs. Switching resets strategy state and auto-pauses the profile."
          >
            <select
              id="strategy-select"
              aria-label="Strategy"
              value={currentKey}
              onChange={(e) => {
                const next = e.currentTarget.value;
                if (next !== currentKey) setPendingStrategy(next);
              }}
              className="rounded-xs border-border bg-surface-alt text-fg focus-visible:border-focus h-11 w-full border px-3 py-2 text-sm focus-visible:outline-none"
            >
              {(strategies.data ?? []).map((s) => (
                <option key={`${s.name}@${s.version}`} value={`${s.name}@${s.version}`}>
                  {s.displayName} ({s.name}@{s.version})
                </option>
              ))}
            </select>
          </Panel>

          {/* Lint + per-symbol feasibility of the SAVED config; re-runs when the
              profile query invalidates after a save, so it tracks edits. */}
          <ConfigDiagnostics profileId={profileId} config={profile.data.config} />

          {descriptor ? (
            // Keyed by strategy so a strategy swap re-mounts the form with
            // the new schema and defaults rather than reusing stale fields.
            // Wrapped in the equity provider so the entry-sizing widget can
            // preview a percent-of-account input as a live quote figure.
            <FormEquityProvider value={equity}>
              <AutoForm
                key={currentKey}
                jsonSchema={descriptor.configSchema}
                defaultValues={(profile.data.config ?? {}) as Record<string, unknown>}
                onSubmit={(values) => save.mutate(values)}
                submitError={save.error}
                formId="config-form"
                defaultOpenGroups
                defaultOpenAdvanced={false}
                aside={
                  <StrategyPreviewPanel
                    strategyName={profile.data.strategyName}
                    profileId={profileId}
                    symbol={boundSymbol?.symbol}
                    currentPrice={previewPrice}
                    account={account}
                    quoteAsset={dash?.quoteAsset}
                    filters={filters}
                  />
                }
              >
                <ForceSellGuardNudge />
                <FormActions className="border-border border-t pt-4">
                  <Button type="submit" variant="default" disabled={save.isPending}>
                    {save.isPending ? 'Saving…' : 'Save'}
                  </Button>
                </FormActions>
              </AutoForm>
            </FormEquityProvider>
          ) : strategies.isLoading ? (
            <p className="text-muted-fg text-xs tracking-wide">Loading config schema…</p>
          ) : strategies.error ? (
            <Alert variant="danger">
              <AlertTitle>Failed to load config schema</AlertTitle>
              <AlertDescription>
                {strategies.error instanceof Error ? strategies.error.message : 'unknown'}
              </AlertDescription>
            </Alert>
          ) : (
            <Alert variant="danger">
              <AlertTitle>Config form unavailable</AlertTitle>
              <AlertDescription>No config schema for strategy {currentKey}.</AlertDescription>
            </Alert>
          )}
        </>
      ) : null}

      <ActionBanner banner={banner} />

      <Dialog open={pendingStrategy !== null} onOpenChange={(o) => !o && setPendingStrategy(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Switch strategy?</DialogTitle>
            <DialogDescription>
              State will reset to the new strategy's initial state. Persistent records (orders,
              archive) are preserved. The profile auto-pauses for the swap; resume it manually after
              verifying the new config.
            </DialogDescription>
          </DialogHeader>
          <FormActions>
            <Button type="button" variant="ghost" onClick={() => setPendingStrategy(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={swap.isPending}
              onClick={() => {
                if (pendingStrategy) swap.mutate(pendingStrategy);
              }}
            >
              {swap.isPending ? 'Switching…' : 'Confirm'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
