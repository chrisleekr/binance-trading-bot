// Per-symbol config override editor, decoupled from any route so it can render
// inside the symbol-page drawer (the redesign's "edit config where you already
// are" surface). Owns its own queries and save/reset mutations; the host only
// supplies the (profileId, symbol) pair and the drawer chrome.
//
// The symbol inherits the profile's strategy config; this editor overrides
// individual keys for one symbol. The effective config a tick runs is
// `mergeConfig(profile.config, overrideConfig)`.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { FormActions } from '@/shared/components/form-actions';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { SymbolConfigForm } from '@/features/symbol/components/symbol-config-form';
import { SymbolReserveCard } from '@/features/symbol/components/symbol-reserve-card';
import { fetchProfile, profileQueryKey } from '@/features/profile/api/profile';
import {
  fetchProfileDashboard,
  profileDashboardQueryKey,
} from '@/features/profile/api/profile-dashboard';
import { strategiesQueryOptions } from '@/features/profile/api/strategies';
import { useStrategyDescriptor } from '@/shared/hooks/use-strategy-descriptor';
import { StrategyPreviewPanel } from '@/features/symbol/preview/strategy-preview-panel';
import {
  accountWireFromBalances,
  filtersFromExchangeInfoSymbol,
} from '@/features/symbol/preview/account-wire';
import { fetchExchangeInfo } from '@/features/symbol/api/exchange-info';
import {
  fetchSymbolOverride,
  patchSymbolOverride,
  symbolOverrideQueryKey,
} from '@/features/symbol/api/symbol';
import { queryDefaults } from '@/shared/lib/query-client';
import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { errorMessage } from '@/shared/lib/api';
import { PanelStackSkeleton } from '@/shared/components/page-skeleton';

/**
 * Self-contained symbol-config editor. Renders the load/error/ready states for
 * the profile config, the strategy schema, and the stored override, then the
 * diff-on-save form plus a reset-to-profile control. `defaultOpenGroups`
 * defaults true here because the panel only ever appears in a drawer the
 * operator opened to edit — collapsed sections would just add clicks.
 */
export function SymbolConfigPanel({
  profileId,
  symbol,
  defaultOpenGroups = true,
}: {
  readonly profileId: string;
  readonly symbol: string;
  readonly defaultOpenGroups?: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const overrideKey = symbolOverrideQueryKey(profileId, symbol);

  const profile = useQuery({
    queryKey: profileQueryKey(profileId),
    queryFn: () => fetchProfile(profileId),
  });
  const strategies = useQuery(strategiesQueryOptions);
  const override = useQuery({
    queryKey: overrideKey,
    queryFn: () => fetchSymbolOverride(profileId, symbol),
  });
  // Live price for this symbol, used only to prefill the preview's entry input.
  // Shares the dashboard cache/TTL the symbol screen already populates, so this
  // is usually a warm read; polls so the prefill tracks the live price.
  const dashboard = useQuery({
    queryKey: profileDashboardQueryKey(profileId),
    queryFn: () => fetchProfileDashboard(profileId),
    staleTime: 5000,
    refetchInterval: 5000,
  });
  // Exchange-wide sizing filters for the bound symbol, so the preview can size a
  // concrete entry quantity. Shares the 5-minute cache the picker already fills.
  const exchangeInfo = useQuery({ ...queryDefaults.exchangeInfo(), queryFn: fetchExchangeInfo });

  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const save = useMutation({
    mutationFn: (overrideConfig: Record<string, unknown> | null) =>
      patchSymbolOverride(profileId, symbol, overrideConfig),
    onSuccess: async (_result, overrideConfig) => {
      setBanner({
        kind: 'ok',
        message:
          overrideConfig === null
            ? 'Override cleared — this symbol now inherits the profile config.'
            : 'Symbol override saved.',
      });
      setConfirmReset(false);
      await queryClient.invalidateQueries({ queryKey: overrideKey });
    },
    onError: (err) => {
      setConfirmReset(false);
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  // Resolve by name only: a profile pinned to a since-bumped strategy_version
  // must still render its override form against the live plugin's schema
  // (version is diagnostic, not a lookup key, mirroring describeForProfile).
  const descriptor = useStrategyDescriptor(profileId);

  const ready = profile.isSuccess && strategies.isSuccess && override.isSuccess;
  const loadError = profile.error ?? strategies.error ?? override.error;

  const currentPrice =
    dashboard.data?.symbols.find((s) => s.symbol === symbol)?.currentPrice ?? null;
  // Wire account for the preview's free-cash sizing (momentum percent-of-account).
  const account = dashboard.data
    ? accountWireFromBalances(dashboard.data.balances, dashboard.data.deployedQuote)
    : undefined;
  const filters = useMemo(
    () =>
      filtersFromExchangeInfoSymbol(exchangeInfo.data?.symbols.find((s) => s.symbol === symbol)),
    [exchangeInfo.data, symbol],
  );

  return (
    <div className="space-y-6" data-testid="symbol-config-panel">
      {/* Shape mirrors what lands here: the reserve card, then the override
          form's groups. */}
      {!ready && !loadError ? <PanelStackSkeleton shape={[2, 5, 4]} /> : null}

      {loadError ? (
        <Alert variant="danger">
          <AlertTitle>Failed to load symbol override</AlertTitle>
          <AlertDescription>
            {loadError instanceof Error ? loadError.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Always-hold reserve: independent of the strategy override form (it is
          account/capital data, not strategy config), so it renders whenever the
          symbol row loaded — even for a strategy that ships no override schema. */}
      {override.isSuccess ? (
        <SymbolReserveCard
          profileId={profileId}
          symbol={symbol}
          reserve={override.data.reserveBaseQuantity}
        />
      ) : null}

      {ready && descriptor === undefined ? (
        <Alert variant="danger">
          <AlertTitle>Config form unavailable</AlertTitle>
          <AlertDescription>
            No override schema for strategy {profile.data.strategyName}@
            {profile.data.strategyVersion}.
          </AlertDescription>
        </Alert>
      ) : null}

      {ready && descriptor !== undefined ? (
        <>
          <p className="text-muted-fg text-sm">
            Fields below start at the profile config. Saved changes override the profile config for
            this symbol only; the candle interval cannot be overridden per symbol.
          </p>
          {/* Keyed by both inputs so the form re-mounts with a freshly-merged
              effective config after a save/reset, or if the profile config
              refetches underneath an open editor. */}
          <SymbolConfigForm
            key={JSON.stringify([
              profile.data.config ?? null,
              override.data.overrideConfig ?? null,
            ])}
            overrideConfigSchema={descriptor.overrideConfigSchema}
            profileConfig={(profile.data.config ?? {}) as Record<string, unknown>}
            overrideConfig={
              (override.data.overrideConfig ?? null) as Record<string, unknown> | null
            }
            onSave={(overrideConfig) => save.mutate(overrideConfig)}
            submitError={save.error}
            defaultOpenGroups={defaultOpenGroups}
            aside={
              <StrategyPreviewPanel
                strategyName={profile.data.strategyName}
                profileId={profileId}
                symbol={symbol}
                currentPrice={currentPrice}
                account={account}
                quoteAsset={dashboard.data?.quoteAsset}
                filters={filters}
              />
            }
          />

          <ActionBanner banner={banner} />

          {/* Sticky action bar — every config section opens by default, so the
              form is tall; pin Save/Reset to the bottom so the primary action
              is always one tap away instead of 20+ screens down. Save submits
              the AutoForm via its `form` attribute (it sits outside the form). */}
          <div className="border-border bg-bg-elevated sticky bottom-0 z-10 flex items-center justify-between gap-2 border-t pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
            <Button
              type="button"
              variant="outline"
              data-testid="symbol-config-reset"
              disabled={save.isPending || override.data.overrideConfig == null}
              onClick={() => setConfirmReset(true)}
            >
              Reset to profile config
            </Button>
            <Button
              type="submit"
              form="symbol-config-form"
              disabled={save.isPending}
              data-testid="symbol-config-save"
            >
              {save.isPending ? 'Saving…' : 'Save override'}
            </Button>
          </div>
        </>
      ) : null}

      <Dialog open={confirmReset} onOpenChange={(o) => !o && setConfirmReset(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset to profile config?</DialogTitle>
            <DialogDescription>
              The per-symbol override is dropped and {symbol} resumes inheriting the profile config
              on the next tick. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <FormActions className="mt-4">
            <Button type="button" variant="outline" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="symbol-config-reset-confirm"
              disabled={save.isPending}
              onClick={() => save.mutate(null)}
            >
              {save.isPending ? 'Resetting…' : 'Reset'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </div>
  );
}
