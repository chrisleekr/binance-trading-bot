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
//         the claim's outcome still has to reach the operator: reported straight
//         off if the read-back already carries it, watched by id if it does not.
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
import {
  outcomeBanner,
  useOutcomeBanner,
  useOverrideOutcome,
} from '@/features/symbol/lib/use-override-outcome';

/**
 * Per-symbol "cancel queued override" entry in the symbol workspace's emergency
 * actions. Deliberately NOT gated on `canForce`, which only covers `trigger-buy`
 * / `trigger-sell`: a profile that declares `manual-order` but no trigger actions
 * can still hold a queued symbol-scoped override, because a manual order records
 * one. Gating on `canForce` would hide the only way to revoke it.
 *
 * Owns its own outcome watch rather than relying on the force-trigger panel's,
 * because that panel unmounts entirely for strategies with no trigger actions and
 * its watch disappears with it. Accepted cost: when both panels end up reporting
 * the same row, whether this one watched it or read it back already settled.
 * Arm a force-sell, cancel it immediately, get a 409 because a
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
      // on an older row plus a newer settled one would disagree. Either way the
      // answer is the newest row in the window: reported straight off if it has
      // already settled, watched by id if it has not, which is why the notices
      // below speak about the action and never about "your cancel".
      // `err.message` is the server's prose, the only place that knows whether a
      // queued row was deleted alongside the claim.
      setBanner({ kind: 'info', message: err.message });
      // Deliberately a bare request, not a read of the override-action query.
      // Only a request issued after the DELETE can describe the world the DELETE
      // left behind, and that key cannot promise one: the workspace co-mounts
      // several outcome watches on it, each polling while armed, so a read of the
      // key joins whichever request is already running rather than starting one.
      // That request is routinely older than this cancel, and the id it carries
      // can be the row the delete just removed. A watch armed on it follows a row
      // that can never answer and ends in a "could not confirm" notice about a
      // cancel that in fact worked. Sharing the key cuts the other way too: any
      // successful mutation anywhere in the app invalidates it, which cancels an
      // in-flight read of the key outright, and the operator is left told to wait
      // for an outcome nothing is watching for.
      //
      // No retry: a failed lookup costs one watch, not the information, because
      // the server's own sentence still stands. The `catch` is belt-and-braces.
      // `useMutation` already swallows a rejection thrown from `onError`, so it
      // is here so a future `onSettled` or `mutateAsync` caller cannot turn a
      // failed id lookup into an unhandled rejection.
      const row = await getOverride(profileId, symbol).catch(() => null);
      if (!row) return;
      // A row that already carries its outcome needs no watch, and must not get
      // one: this read is the freshest the symbol has, so it is safe to say now.
      // Arming instead would put the verdict behind a poll, where a newer
      // override landing for the symbol reads as superseding this row and
      // retires the watch in silence, losing a settled answer about money that
      // already moved. `clear` first, because a watch this panel armed on an
      // earlier 409 may be following the very row this read just answered for:
      // left running, its own poll surfaces the same outcome and says it twice.
      // A watch left running on an earlier row does not retire quietly either: a
      // newer row reads as a displacement and ends that watch in "could not
      // confirm", which would bury this settled answer under an unknown.
      if (row.outcome) {
        outcomeWatch.clear();
        setBanner(outcomeBanner(row.outcome));
        return;
      }
      outcomeWatch.watch(row.id, row.createdAt);
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
