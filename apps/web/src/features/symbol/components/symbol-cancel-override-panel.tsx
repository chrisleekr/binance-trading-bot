// SymbolCancelOverridePanel — revokes a manual override the operator queued and
// then thought better of. Arming one and watching its outcome already had
// surfaces; without this, a mis-armed force-sell could only be waited out.
//
// Scope is exactly what the route can reach: overrides recorded against THIS
// symbol — force buy/sell and manual orders. A queued dust conversion is
// recorded with `symbol: null` and the route's lookup filters on symbol
// equality, so it can never be found here. Naming dust in the copy would earn a
// 204 that reads as "cancelled" while the conversion still runs.
//
// The route's three answers mean three different things, and the copy has to
// keep them apart:
//   204 — the request went through. It does NOT prove a row existed, and it does
//         not prove the queue is now empty either (a newer unclaimed override may
//         have landed after the delete and been left alone), so the notice reports
//         the action taken and never the resulting world state.
//   409 — a live claim holds the row: the bot is mid-dispatch and the cancel lost
//         the race. Neither a success nor a breakage, so it rides an `info`
//         notice carrying the server's own prose — which is the only thing that
//         knows whether a queued row was deleted alongside the claimed one — and
//         the claimed override's outcome is worth watching.
//   404 — wrong or unowned profile. A real failure.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

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
import { ApiError, errorMessage } from '@/shared/lib/api';
import {
  cancelOverride,
  getOverride,
  symbolOverrideActionQueryKey,
} from '@/features/symbol/api/symbol';
import { useOutcomeBanner, useOverrideOutcome } from '@/features/symbol/lib/use-override-outcome';

/**
 * Per-symbol "cancel queued override" entry in the symbol workspace's emergency
 * actions. Deliberately NOT gated on `canForce`, which only covers `trigger-buy`
 * / `trigger-sell`: a profile that declares `manual-order` but no trigger actions
 * can still hold a queued symbol-scoped override, because a manual order records
 * one. Gating on `canForce` would hide the only way to revoke it.
 *
 * Owns its own outcome watch rather than relying on the force-trigger panel's,
 * because that panel unmounts entirely for strategies with no trigger actions and
 * its watch disappears with it. Accepted cost: when both panels end up watching
 * the same row — arm a force-sell, cancel it immediately, get a 409 because a
 * tick already claimed it, and this panel's read-back lands on that same row — the
 * operator sees its outcome twice. Duplicated, never wrong, and the alternative
 * is no notice at all on strategies that never mount the other panel.
 */
export function SymbolCancelOverridePanel({
  profileId,
  symbol,
}: {
  readonly profileId: string;
  readonly symbol: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const queryClient = useQueryClient();
  const outcomeWatch = useOverrideOutcome(profileId, symbol);
  useOutcomeBanner(outcomeWatch, setBanner);
  // A ref is the synchronous double-fire guard; `isPending` only flips on the
  // next render, so two clicks in the same tick would both fire the mutation.
  const firingRef = useRef(false);

  const cancel = useMutation({
    mutationFn: () => cancelOverride(profileId, symbol),
    onSuccess: async () => {
      setBanner({
        kind: 'ok',
        message: `Cancelled any override that was still waiting on ${symbol}.`,
      });
      setOpen(false);
      firingRef.current = false;
      // No `outcomeWatch.clear()` here. A 204 also comes back when the row this
      // panel is watching has just SETTLED (the route's "active" test excludes
      // consumed rows), and clearing would disable the query that is about to
      // read that outcome — telling the operator nothing is waiting and then
      // never revealing whether their force-sell filled. The refetch below plus
      // the watch's own read decide on evidence instead: a deleted row reads back
      // as gone and clears itself, a settled one surfaces its outcome.
      await queryClient.invalidateQueries({
        queryKey: symbolOverrideActionQueryKey(profileId, symbol),
      });
    },
    onError: async (err) => {
      firingRef.current = false;
      setOpen(false);
      if (!(err instanceof ApiError && err.status === 409 && err.code === 'CONFLICT')) {
        setBanner({ kind: 'err', message: errorMessage(err) });
        return;
      }
      // The 409 body carries no id, so read the row back to learn what to watch.
      // The read returns the newest override in the outcome window — normally the
      // claimed one, though not provably so: the 409 is decided from the newest
      // UNCONSUMED row while this read ignores `consumed_at`, so a stalled claim
      // on an older row plus a newer settled one would disagree. The watch's own
      // identity check absorbs that. `err.message` is the server's prose, the only
      // place that knows whether a queued row was deleted alongside the claim.
      setBanner({ kind: 'info', message: err.message });
      const row = await queryClient
        .fetchQuery({
          queryKey: symbolOverrideActionQueryKey(profileId, symbol),
          queryFn: () => getOverride(profileId, symbol),
          // Must hit the network. The app-wide `staleTime: Infinity` would hand
          // back whatever a sibling panel's poll last cached, and the whole point
          // of this read is learning the id the 409 omits — a cached row can be
          // the one this cancel just deleted, which would arm a watch that never
          // matches. `gcTime: 0` because react-query only ever RAISES gcTime, so
          // inheriting the 30-minute default would permanently undo the 0 the
          // watch hook chose and keep stale rows alive across symbol switches.
          staleTime: 0,
          gcTime: 0,
          // Not worth retrying: the outcome poll re-reads this key on its own
          // cadence, so a failed id lookup costs one watch, not the information.
          retry: false,
        })
        // Belt-and-braces. `useMutation` already swallows a rejection thrown from
        // `onError`, so today this changes nothing observable — it is here so a
        // future `onSettled` or `mutateAsync` caller cannot turn a failed id
        // lookup into an unhandled rejection.
        .catch(() => null);
      if (row) outcomeWatch.watch(row.id);
    },
  });

  return (
    <section className="space-y-2" data-testid="symbol-cancel-override-panel">
      <Button
        type="button"
        variant="destructive"
        className="w-full"
        onClick={() => {
          setBanner(null);
          setOpen(true);
        }}
        data-testid="symbol-cancel-override-open"
      >
        Cancel queued override
      </Button>

      <ActionBanner banner={banner} />

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel the queued override on {symbol}?</DialogTitle>
            <DialogDescription>
              Removes the manual buy or sell waiting for the next check on {symbol}, so the bot
              never runs it. Your normal strategy for {symbol} keeps running.
            </DialogDescription>
          </DialogHeader>

          <Alert variant="danger">
            <AlertTitle>⚠ The bot may already be acting on it</AlertTitle>
            <AlertDescription>
              If a check has already picked the action up, cancelling comes too late and you will be
              told to wait for its outcome instead. That stays the answer until the bot finishes
              with it, which can be up to ten minutes if the check that took it stalled.
            </AlertDescription>
          </Alert>

          <FormActions>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="symbol-cancel-override-confirm"
              disabled={cancel.isPending}
              onClick={() => {
                if (firingRef.current || cancel.isPending) return;
                firingRef.current = true;
                cancel.mutate();
              }}
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel override'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </section>
  );
}
