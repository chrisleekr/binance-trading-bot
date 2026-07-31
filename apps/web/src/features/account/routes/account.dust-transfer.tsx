// /account/dust-transfer — multi-select Binance dust conversion.
//
// Lists assets above the 0.001 BTC threshold (excluding BNB and BTC themselves
// since those cannot be the *source* of a dust conversion), shows the running
// estimated-BTC sum as the operator selects, and submits the chosen symbols.
// The POST returns an override-action id; Binance gets called from the worker.
//
// `?profileId=…` as a search param so this route is reachable without nesting
// under the per-profile root that lands with #8.

import { useQuery } from '@tanstack/react-query';
import { createRoute, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { BackLink, Page, PageHeader } from '@/shared/components/page';
import { Panel } from '@/shared/components/panel';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { useProfiles } from '@/features/profile/lib/profile-context';
import {
  fetchDustHistory,
  fetchDustList,
  submitDustTransfer,
} from '@/features/account/api/dust-transfer';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { useTimezone } from '@/shared/context/timezone-context';
import { formatInstant } from '@/shared/lib/format-time';

import type { DustAsset } from '@app/contracts';

// Binance's dust-transfer minimum is 0.001 BTC equivalent. Anything below is
// not eligible regardless of `canDustTransfer` so we drop it from the UI list.
// String comparison is not safe for arbitrary decimals; we widen to Number for
// the eligibility predicate and the running preview only — the operator never
// see-saws a single satoshi on this screen and the actual value flowing back
// to Binance is the asset *symbol* (string), not the BTC estimate.
const DUST_THRESHOLD_BTC = 0.001;
// BNB is the destination asset and BTC is the quote asset for the estimate;
// neither can be the source of a dust conversion.
const NON_SOURCE_ASSETS = new Set(['BNB', 'BTC']);

// `profileId` is optional: a bare `/account/dust-transfer` visit falls back to
// the active profile from context. The dust pool is exchange-account-wide so
// any profile's API key reaches it.
const SearchSchema = z.object({ profileId: z.string().min(1).optional() });
type Search = z.infer<typeof SearchSchema>;

const isEligible = (asset: DustAsset): boolean =>
  asset.canDustTransfer &&
  !NON_SOURCE_ASSETS.has(asset.asset) &&
  Number(asset.estimatedBTC) >= DUST_THRESHOLD_BTC;

const sumEstimatedBtc = (assets: readonly DustAsset[]): string => {
  // Fixed-point string sum to 8 decimals (BTC precision) avoids visible IEEE-754
  // drift in the preview. The value never crosses the API boundary — the POST
  // body sends asset symbols, not amounts.
  const total = assets.reduce((acc, a) => acc + Number(a.estimatedBTC), 0);
  return total.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
};

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
      <PageHeader title="Dust transfer" back={<BackLink to="/account" />} />

      <p className="text-muted-fg text-sm">
        Convert leftover small balances ("dust") in your Binance spot wallet into BNB in one click.
        Only assets at or above Binance's {DUST_THRESHOLD_BTC} BTC minimum are eligible; BNB and BTC
        are excluded because they cannot be the source of a dust conversion. Binance allows one dust
        conversion per 6-hour window.
      </p>

      {profileId === null ? (
        <p className="text-muted-fg text-sm">No profile available. Create a profile first.</p>
      ) : null}

      {list.isLoading ? <p className="text-sm">Loading balances…</p> : null}
      {list.error ? (
        <Alert variant="danger">
          <AlertTitle>Failed</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      {profileId !== null && !list.isLoading && eligible.length === 0 && !list.error ? (
        <div className="text-muted-fg space-y-1 text-sm">
          <p>No dust-eligible assets (≥ {DUST_THRESHOLD_BTC} BTC).</p>
          <p className="text-xs">
            Binance allows dust conversion on live accounts only — testnet profiles always render
            empty here.
          </p>
        </div>
      ) : null}

      {eligible.length > 0 ? (
        <Panel title="Eligible assets">
          <form onSubmit={onSubmit} className="space-y-4">
            <ul className="divide-border divide-y">
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
                        className="accent-accent size-4"
                      />
                      <span className="font-medium">{asset.asset}</span>
                    </label>
                    <span className="text-muted-fg font-mono text-sm tabular-nums">
                      {asset.estimatedBTC} BTC
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-fg text-xs">{selectedAssets.length} selected</span>
              <span className="font-mono tabular-nums">{previewBtc} BTC</span>
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

      {profileId !== null && (history.data?.length ?? 0) > 0 ? (
        <Panel title="Recent conversions">
          <ul className="divide-border divide-y">
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
                  <span className="text-muted-fg text-xs tabular-nums">
                    {formatInstant(row.createdAt, timeZone)}
                  </span>
                </div>
                <div className="text-muted-fg text-xs">
                  {(row.convertedAssets ?? row.requestedAssets).join(', ') || '—'}
                  {row.bnbReceived !== null ? (
                    <span className="text-fg font-mono tabular-nums"> → {row.bnbReceived} BNB</span>
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
