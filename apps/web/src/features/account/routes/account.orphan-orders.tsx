// /accounts/:accountId/orphan-orders — adopt orders the bot isn't tracking.
//
// An "orphan" is an order open on the Binance master account that no profile
// has a local record of: one placed by hand outside the bot, or left behind
// when a coin stopped trading. The list is the worker's periodic snapshot (the
// API has no Binance connection of its own), so a just-adopted order can linger
// until the next snapshot — the page removes it locally on a successful adopt so
// "adopted leaves the list" holds immediately.

import { useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { Page, PageHeader } from '@/shared/components/page';
import { Panel } from '@/shared/components/panel';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { adoptOrphanOrder, fetchOrphanOrders } from '@/features/account/api/orphan-orders';
import { formatAmount, formatPrice } from '@/shared/lib/format';
import { formatInstant } from '@/shared/lib/format-time';
import { accountScopeRoute } from '@/features/account/routes/account-scope';
import { useTimezone } from '@/shared/context/timezone-context';

import { isRestingSell } from '@app/contracts';
import type { OrphanOrderView } from '@app/contracts';
import { PanelStackSkeleton } from '@/shared/components/page-skeleton';

const lastChecked = (computedAtMs: number | null, timeZone: string): string =>
  computedAtMs === null
    ? 'Not checked yet — the background scan runs every few minutes.'
    : `Last checked ${formatInstant(computedAtMs, timeZone)}.`;

function OrphanOrdersPage(): React.JSX.Element {
  const timeZone = useTimezone();
  const query = useQuery({
    queryKey: ['orphan-orders', 'list'],
    queryFn: fetchOrphanOrders,
  });

  // Orders adopted this session, removed from the list immediately so the
  // snapshot's lag does not show a just-adopted order as still orphaned.
  const [adopted, setAdopted] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<OrphanOrderView | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);

  const closeDialog = (): void => setConfirming(null);

  // Identity is (mode, orderId), not orderId alone: an order id is unique only
  // within one Binance account, so a testnet and a live orphan can share a
  // numeric id. Keying rows/state by id alone would collide them (duplicate
  // React keys, shared adopted state across two distinct orders).
  const rowKey = (o: OrphanOrderView): string => `${o.mode}:${o.orderId}`;

  const orphans = (query.data?.orphans ?? []).filter((o) => !adopted.has(rowKey(o)));

  const onConfirmAdopt = async (): Promise<void> => {
    if (!confirming || confirming.ownerProfileId === null) return;
    const orderId = confirming.orderId;
    const symbol = confirming.symbol;
    const ownerName = confirming.ownerProfileName ?? 'its profile';
    setSubmitting(true);
    try {
      await adoptOrphanOrder({ orderId, mode: confirming.mode });
      setAdopted((prev) => new Set(prev).add(rowKey(confirming)));
      setBanner({
        kind: 'ok',
        message: `Handed ${symbol} back to ${ownerName}. The bot is managing it again.`,
      });
      closeDialog();
    } catch (err) {
      // Close the dialog so the error toast is visible; the reason (e.g.
      // "already adopted" when the snapshot lagged) rides the toast.
      closeDialog();
      setBanner({ kind: 'err', message: err instanceof Error ? err.message : 'adopt failed' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Page>
      <PageHeader title="Orphan orders" />
      <p className="text-sm text-muted-fg">
        Orders open on Binance that the bot isn&rsquo;t tracking (&ldquo;orphans&rdquo;) — one it
        placed but lost track of, one you placed by hand, or one left behind when a coin stopped
        trading. An order the bot recognises can be handed back to the profile that placed it; one
        it does not recognise cannot be adopted at all, because no profile would know what to do
        with it.
      </p>

      {query.isLoading ? <PanelStackSkeleton shape={[4]} /> : null}
      {query.error ? (
        <Alert variant="danger">
          <AlertTitle>Failed to load</AlertTitle>
          <AlertDescription>
            {query.error instanceof Error ? query.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      <ActionBanner banner={banner} />

      {!query.isLoading && !query.error ? (
        <p className="text-xs text-muted-fg">
          {lastChecked(query.data?.computedAtMs ?? null, timeZone)}
        </p>
      ) : null}

      {!query.isLoading && !query.error && orphans.length === 0 ? (
        <p className="text-sm text-muted-fg">
          No orphan orders — every order open on Binance is already tracked by the bot.
        </p>
      ) : null}

      {orphans.length > 0 ? (
        <Panel title="Orders to adopt">
          <ul className="divide-y divide-border">
            {orphans.map((o) => {
              const k = rowKey(o);
              return (
                <li key={k} className="space-y-3 py-4" data-testid={`orphan-${k}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <p className="font-medium text-fg">{o.symbol}</p>
                      <p className="text-xs">
                        <span className={o.side === 'BUY' ? 'text-success' : 'text-danger'}>
                          {o.side}
                        </span>{' '}
                        <span className="font-mono text-muted-fg tabular-nums">
                          {formatAmount(o.origQty)} @ {formatPrice(o.price)}
                        </span>
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[11px] font-medium uppercase ${
                          o.mode === 'live'
                            ? 'bg-danger/10 text-danger'
                            : 'bg-bg-elevated text-muted-fg'
                        }`}
                      >
                        {o.mode === 'live' ? 'Live' : 'Testnet'}
                      </span>
                      <span className="text-xs text-muted-fg">{o.status}</span>
                    </div>
                  </div>
                  {o.ownerProfileId === null && isRestingSell(o) ? (
                    // Un-adoptable AND holding the coins — the worst case, so it gets
                    // the specific warning. No profile can prove it placed this, so
                    // nothing can take it over, and while it rests the base stays
                    // locked and the true owner cannot fund a protective stop for it.
                    // The api refuses this too (409); saying so here means the
                    // operator never has to hit the error to find out.
                    <p className="text-xs text-danger">
                      This sell order is holding your coins on Binance, so a profile that adopted it
                      could not place a protective stop for them. Cancel it on Binance first, then
                      adopt the position.
                    </p>
                  ) : o.ownerProfileId === null ? (
                    // Not adoptable, and there is no picker to offer instead: the
                    // only safe home for a lost order is the profile that placed
                    // it, and no profile here can prove it did. Say what the two
                    // real options are.
                    <p className="text-xs text-muted-fg">
                      No profile on this account placed this order, so the bot cannot take it over —
                      it would have no idea what the order is for. Either cancel it on Binance, or
                      leave it alone if you meant to place it.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 text-xs text-muted-fg">
                        Placed by <span className="font-medium text-fg">{o.ownerProfileName}</span>{' '}
                        — hand it back and the bot resumes managing it.
                      </p>
                      <Button variant="default" onClick={() => setConfirming(o)}>
                        Adopt
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      ) : null}

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Hand this order back?</DialogTitle>
            <DialogDescription>
              {confirming
                ? `${confirming.side} ${formatAmount(confirming.origQty)} ${confirming.symbol} @ ${formatPrice(confirming.price)} was placed by ${confirming.ownerProfileName}. Handing it back lets that profile manage it again — trailing its stop and counting its fills.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <FormActions>
            <Button variant="ghost" onClick={closeDialog} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="default" onClick={onConfirmAdopt} disabled={submitting}>
              {submitting ? 'Adopting…' : 'Confirm adopt'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

/**
 * `/accounts/:accountId/orphan-orders` — adopt orders open on Binance that the
 * bot is not tracking. Account-scoped: the orphan set is exchange-account-wide
 * (one key pair per account), so it carries no profile in the path. Adoption is
 * a per-order action that picks the owning profile.
 */
export const orphanOrdersRoute = createRoute({
  staticData: { title: 'Orphan orders' },
  getParentRoute: () => accountScopeRoute,
  path: '/orphan-orders',
  component: OrphanOrdersPage,
});
