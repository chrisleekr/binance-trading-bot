// DustCancelPanel — revokes a dust conversion the operator queued and then
// thought better of. Without it a mis-clicked conversion can only be waited out,
// and it moves real balances: dust is converted to BNB one way.
//
// Scope is profile-wide, never symbol-scoped, and never the whole account. Dust
// rows carry no symbol, so arming one supersedes nothing and a profile can hold
// several queued at once; the route deletes every unclaimed one belonging to THIS
// profile, and the copy says so rather than implying a single row.
//
// The route's three answers mean different things and the copy keeps them apart:
//   204 — the request went through. It does NOT prove the queue is now empty: a
//         conversion armed after the delete is left alone, so the notice reports
//         the action taken and never the resulting world state.
//   409 — the worker already holds a claim and may have called Binance. Neither a
//         success nor a breakage, so it rides an `info` notice carrying the
//         server's own sentence, which is the only thing that knows whether
//         queued rows were removed alongside the claimed one.
//   404 — wrong or unowned profile. A real failure.

import { useMutation } from '@tanstack/react-query';
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
import { cancelDustTransfer } from '@/features/account/api/dust-transfer';

/**
 * Cancel entry for the dust-transfer screen, mounted only while a conversion is
 * queued or running. `onDone` refreshes both the eligible list and the history:
 * the cancelled row is what the history is showing, and an asset that stays
 * unconverted belongs back in the list.
 */
export function DustCancelPanel({
  profileId,
  onDone,
}: {
  readonly profileId: string;
  readonly onDone: () => Promise<unknown>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  // A ref is the synchronous double-fire guard; `isPending` only flips on the
  // next render, so two clicks in the same tick would both fire the mutation.
  const firingRef = useRef(false);

  const cancel = useMutation({
    mutationFn: () => cancelDustTransfer(profileId),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Cancelled any conversion that was still waiting.' });
      setOpen(false);
      firingRef.current = false;
      await onDone();
    },
    onError: async (err) => {
      firingRef.current = false;
      setOpen(false);
      if (err instanceof ApiError && err.status === 409 && err.code === 'CONFLICT') {
        setBanner({ kind: 'info', message: err.message });
      } else {
        setBanner({ kind: 'err', message: errorMessage(err) });
      }
      // Refresh on the conflict too: the server may have removed queued rows
      // while refusing the claimed one, and a stale history would keep offering
      // to cancel conversions that are already gone.
      await onDone();
    },
  });

  return (
    <section className="space-y-2" data-testid="dust-cancel-panel">
      <Button
        type="button"
        variant="destructive"
        className="w-full sm:w-56"
        onClick={() => {
          setBanner(null);
          setOpen(true);
        }}
        data-testid="dust-cancel-open"
      >
        Cancel queued conversion
      </Button>

      <ActionBanner banner={banner} />

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel the queued conversion?</DialogTitle>
            <DialogDescription>
              Removes every dust conversion still waiting, so the bot never runs them. Balances stay
              exactly where they are and nothing already converted comes back.
            </DialogDescription>
          </DialogHeader>

          <Alert variant="danger">
            <AlertTitle>⚠ The bot may already be converting</AlertTitle>
            <AlertDescription>
              If it has already sent the conversion to Binance, cancelling comes too late and you
              will be told to wait for the outcome instead. Converted dust cannot be turned back.
            </AlertDescription>
          </Alert>

          <FormActions>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="dust-cancel-confirm"
              disabled={cancel.isPending}
              onClick={() => {
                if (firingRef.current || cancel.isPending) return;
                firingRef.current = true;
                cancel.mutate();
              }}
            >
              {cancel.isPending ? 'Cancelling…' : 'Cancel conversion'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </section>
  );
}
