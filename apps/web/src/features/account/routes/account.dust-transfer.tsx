// /account/dust-transfer — multi-select Binance dust conversion.
//
// Lists assets above the 0.001 BTC threshold (excluding BNB and BTC themselves
// since those cannot be the *source* of a dust conversion), shows the running
// estimated-BTC sum as the operator selects, and submits the chosen symbols.
// The POST returns an override-action id; Binance gets called from the worker.
//
// `?profileId=…` as a search param so this route is reachable without nesting
// under the per-profile root.

import { useQuery } from '@tanstack/react-query';
import { createRoute, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { Page, PageHeader } from '@/shared/components/page';
import { Panel } from '@/shared/components/panel';
import { LoadingRows } from '@/shared/components/page-skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { useProfiles } from '@/features/profile/lib/profile-context';
import {
  fetchDustHistory,
  fetchDustList,
  submitDustTransfer,
} from '@/features/account/api/dust-transfer';
import { DustCancelPanel } from '@/features/account/components/dust-cancel-panel';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatAmount, formatBalanceAmount } from '@/shared/lib/format';
import { formatInstant } from '@/shared/lib/format-time';

import { decimalAdd, type DustAsset } from '@app/contracts';

// Binance's dust-transfer minimum is 0.001 BTC equivalent. Anything below is not eligible regardless of `canDustTransfer` so we drop it from the UI list. String comparison is not safe for arbitrary decimals, so the eligibility predicate widens one stored value to Number to compare it against this threshold. That is a single-value comparison against a constant, not an accumulation: nothing is summed there, so there is nothing for the error to build up in, and the value flowing back to Binance is the asset *symbol* anyway, never the BTC estimate.
const DUST_THRESHOLD_BTC = 0.001;
// BNB is the destination asset and BTC is the quote asset for the estimate;
// neither can be the source of a dust conversion.
const NON_SOURCE_ASSETS = new Set(['BNB', 'BTC']);

// Shared by the pending placeholder and the loaded panel so the chrome the
// operator sees mid-load is the chrome they keep.
const ELIGIBLE_PANEL_TITLE = 'Eligible assets';

// `profileId` is optional: a bare `/account/dust-transfer` visit falls back to
// the active profile from context. The dust pool is exchange-account-wide so
// any profile's API key reaches it.
const SearchSchema = z.object({ profileId: z.string().min(1).optional() });
type Search = z.infer<typeof SearchSchema>;

const isEligible = (asset: DustAsset): boolean =>
  asset.canDustTransfer &&
  !NON_SOURCE_ASSETS.has(asset.asset) &&
  Number(asset.estimatedBTC) >= DUST_THRESHOLD_BTC;

/**
 * Total the selected assets' BTC estimates as decimal strings.
 *
 * `decimalAdd`, not `acc + Number(...)`: the accumulator is money, and the comment that used to sit here claimed a fixed-point sum while the code did the opposite. The visible defect was not the arithmetic but the rendering that followed it — the total was stringified raw and trimmed while every row beside it went through the shared balance formatter, so a selection landing on a whole number read `1 BTC` directly under rows reading `0.4000 BTC`. Formatting is now the caller's job through that same helper, which is what makes the total and its parts unable to disagree.
 *
 * @param assets - The eligible assets the operator has ticked, in any order.
 * @returns Their summed BTC estimate as a plain decimal string, `'0'` for an empty selection.
 */
const sumEstimatedBtc = (assets: readonly DustAsset[]): string =>
  assets.reduce<string>((acc, a) => decimalAdd(acc, a.estimatedBTC), '0');

function DustTransferPage(): React.JSX.Element {
  const timeZone = useTimezone();
  const { profileId: searchProfileId } = useSearch({ from: dustTransferRoute.id });
  const { activeProfileId } = useProfiles();
  const profileId = searchProfileId ?? activeProfileId;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const list = useQuery({
    queryKey: ['dust-transfer', 'list', profileId],
    queryFn: () => fetchDustList(profileId ?? ''),
    enabled: profileId !== null,
  });

  const history = useQuery({
    queryKey: ['dust-transfer', 'history', profileId],
    queryFn: () => fetchDustHistory(profileId ?? ''),
    enabled: profileId !== null,
  });

  // `processing` counts as cancellable from here: the route decides whether the
  // worker's claim is live, and hiding the button on a claimed row would leave an
  // operator with no way to clear the queued rows stacked behind it.
  const queued = (history.data ?? []).some((row) => row.status !== 'done');
  const eligible = (list.data ?? []).filter(isEligible);
  const eligibleByAsset = new Map(eligible.map((a) => [a.asset, a] as const));
  const selectedAssets = [...selected]
    .map((s) => eligibleByAsset.get(s))
    .filter((a): a is DustAsset => a !== undefined);
  const previewBtc = sumEstimatedBtc(selectedAssets);

  const toggle = (asset: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(asset)) next.delete(asset);
      else next.add(asset);
      return next;
    });
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    // Derive submit body from `selectedAssets` (already filtered against the
    // current `eligible` list), not from the raw `selected` set. After a
    // background refetch, an asset can drop out of eligibility — submitting
    // it would either 400 or, worse, succeed for an asset Binance later
    // refuses to convert.
    if (selectedAssets.length === 0 || profileId === null) return;
    setBanner(null);
    setSubmitting(true);
    try {
      const res = await submitDustTransfer(profileId, {
        assets: selectedAssets.map((a) => a.asset),
      });
      setBanner({
        kind: 'ok',
        message: `Scheduled — override ${res.overrideActionId.slice(0, 8)}…`,
      });
      setSelected(new Set());
      await Promise.all([list.refetch(), history.refetch()]);
    } catch (err) {
      setBanner({ kind: 'err', message: err instanceof Error ? err.message : 'submit failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Page>
      <PageHeader title="Dust transfer" />

      <p className="text-sm text-muted-fg">
        Convert leftover small balances ("dust") in your Binance spot wallet into BNB in one click.
        Only assets at or above Binance's {DUST_THRESHOLD_BTC} BTC minimum are eligible; BNB and BTC
        are excluded because they cannot be the source of a dust conversion. Binance allows one dust
        conversion per 6-hour window.
      </p>

      {profileId === null ? (
        <p className="text-sm text-muted-fg">No profile available. Create a profile first.</p>
      ) : null}

      {/* Stands in for the eligible-assets panel: one checkbox row per
          dust-eligible balance, plus the convert action. */}
      {list.isLoading || list.isPaused ? (
        <Panel title={ELIGIBLE_PANEL_TITLE}>
          <LoadingRows rows={6} />
        </Panel>
      ) : null}
      {list.error ? (
        <Alert variant="danger">
          <AlertTitle>Failed</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* `isPaused` as well as `isLoading`: a first fetch queued behind an
          offline network leaves `isLoading` false with no data, which would
          otherwise read as a confirmed empty wallet. */}
      {profileId !== null &&
      !list.isLoading &&
      !list.isPaused &&
      eligible.length === 0 &&
      !list.error ? (
        <div className="space-y-1 text-sm text-muted-fg">
          <p>No dust-eligible assets (≥ {DUST_THRESHOLD_BTC} BTC).</p>
          <p className="text-xs">
            Binance allows dust conversion on live accounts only — testnet profiles always render
            empty here.
          </p>
        </div>
      ) : null}

      {eligible.length > 0 ? (
        <Panel title={ELIGIBLE_PANEL_TITLE}>
          <form onSubmit={onSubmit} className="space-y-4">
            <ul className="divide-y divide-border">
              {eligible.map((asset) => {
                const checked = selected.has(asset.asset);
                return (
                  <li key={asset.asset} className="flex items-center justify-between py-2">
                    <label className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(asset.asset)}
                        aria-label={asset.asset}
                        className="size-4 accent-accent"
                      />
                      <span className="font-medium">{asset.asset}</span>
                    </label>
                    {/* formatBalanceAmount, not formatAmount: this is a tabular column, and formatAmount sets no MINIMUM fraction digits, so 0.0001 sits beside 0.00012345 ragged and anything under 5e-9 collapses to a bare 0. */}
                    <span className="font-mono text-sm text-muted-fg tabular-nums">
                      {formatBalanceAmount(asset.estimatedBTC)} BTC
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between text-sm">
              <span className="text-xs text-muted-fg">{selectedAssets.length} selected</span>
              <span className="font-mono tabular-nums">{formatBalanceAmount(previewBtc)} BTC</span>
            </div>
            <ActionBanner banner={banner} />
            <Button
              type="submit"
              variant="primary"
              disabled={submitting || selectedAssets.length === 0}
              className="w-full sm:w-56"
            >
              {submitting ? 'Scheduling…' : 'Convert to BNB'}
            </Button>
          </form>
        </Panel>
      ) : null}

      {/* Mounted only while something is actually cancellable. A permanently
          visible destructive button on a screen whose usual state is "nothing
          queued" reads as an offer to undo conversions that already happened. */}
      {profileId !== null && queued ? (
        <Panel title="Queued conversion">
          <DustCancelPanel
            profileId={profileId}
            onDone={() => Promise.all([list.refetch(), history.refetch()])}
          />
        </Panel>
      ) : null}

      {profileId !== null && (history.data?.length ?? 0) > 0 ? (
        <Panel title="Recent conversions">
          <ul className="divide-y divide-border">
            {history.data?.map((row) => (
              <li key={row.id} className="space-y-1 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium">
                    {row.status === 'done'
                      ? `Converted ${row.convertedAssets?.length ?? 0} asset(s)`
                      : row.status === 'processing'
                        ? 'Converting…'
                        : 'Queued'}
                  </span>
                  <span className="text-xs text-muted-fg tabular-nums">
                    {formatInstant(row.createdAt, timeZone)}
                  </span>
                </div>
                <div className="text-xs text-muted-fg">
                  {(row.convertedAssets ?? row.requestedAssets).join(', ') || '—'}
                  {row.bnbReceived !== null ? (
                    <span className="font-mono text-fg tabular-nums">
                      {' '}
                      → {formatAmount(row.bnbReceived)} BNB
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </Page>
  );
}

/**
 * `/account/dust-transfer` — multi-select Binance dust → BNB conversion.
 *
 * Mounted under `/account` (not `/profiles/$id`) because the dust pool is
 * exchange-account-wide; profile selection is carried in the search param so
 * the route remains addressable without a parent profile route. The POST
 * returns immediately with an override-action id — Binance gets called from
 * the worker so a slow upstream cannot stall the operator's click.
 */
export const dustTransferRoute = createRoute({
  staticData: { title: 'Dust transfer' },
  getParentRoute: () => accountScopeRoute,
  path: '/dust-transfer',
  validateSearch: (search: Record<string, unknown>): Search => SearchSchema.parse(search),
  component: DustTransferPage,
});
