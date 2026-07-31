// SymbolStopTrackingPanel — first-class "stop tracking this symbol" control at
// the foot of the symbol workspace, beside the pause panel. Pause is temporary;
// this is the permanent teardown: it removes the symbol from the profile so the
// strategy stops touching it. A confirm dialog spells out what it does NOT do
// (it never sells the balance, never cancels live Binance orders) so the
// operator cannot one-click into a surprise. Reuses the same `wipeSymbol`
// mutation the advanced drawer's wipe action calls.

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
import { errorMessage } from '@/shared/lib/api';
import { symbolStateQueryKey, wipeSymbol } from '@/features/symbol/api/symbol';

/**
 * Per-symbol "stop tracking" entry in the symbol workspace trade tab, below
 * Force trigger. A destructive button opens a confirm dialog; confirming removes the symbol from
 * the profile via `wipeSymbol` and calls `onWiped` so the route navigates away
 * from the now-deleted resource.
 */
export function SymbolStopTrackingPanel({
  profileId,
  symbol,
  onWiped,
}: {
  readonly profileId: string;
  readonly symbol: string;
  /** Called after the wipe succeeds so the route can navigate off the deleted symbol. */
  readonly onWiped?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const queryClient = useQueryClient();
  // A ref is the synchronous double-fire guard; `isPending` only flips on the
  // next render, so two clicks in the same tick would both fire the mutation.
  const firingRef = useRef(false);

  const wipe = useMutation({
    mutationFn: () => wipeSymbol(profileId, symbol),
    onSuccess: async () => {
      setBanner({ kind: 'ok', message: 'Symbol removed from profile.' });
      setOpen(false);
      firingRef.current = false;
      await queryClient.invalidateQueries({ queryKey: symbolStateQueryKey(profileId, symbol) });
      onWiped?.();
    },
    onError: (err) => {
      firingRef.current = false;
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  return (
    <section className="space-y-2" data-testid="symbol-stop-tracking-panel">
      <Button
        type="button"
        variant="destructive"
        className="w-full"
        onClick={() => {
          setBanner(null);
          setOpen(true);
        }}
        data-testid="symbol-stop-tracking-open"
      >
        Stop tracking
      </Button>

      <ActionBanner banner={banner} />

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Stop tracking {symbol}?</DialogTitle>
            <DialogDescription>
              Removes {symbol} from this profile entirely: its per-symbol configuration, the
              recorded average entry price, the strategy&apos;s saved position, and any pending
              actions. The trade history is kept for audit. The strategy stops touching {symbol}.
              This is irreversible.
            </DialogDescription>
          </DialogHeader>

          <Alert variant="danger">
            <AlertTitle>⚠ Your balance and open orders are untouched</AlertTitle>
            <AlertDescription>
              This does not sell your {symbol} balance, and does not cancel any live Binance orders.
              Cancel them on Binance first if you need them gone.
            </AlertDescription>
          </Alert>

          <FormActions>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="symbol-stop-tracking-confirm"
              disabled={wipe.isPending}
              onClick={() => {
                if (firingRef.current || wipe.isPending) return;
                firingRef.current = true;
                wipe.mutate();
              }}
            >
              {wipe.isPending ? 'Removing…' : 'Stop tracking'}
            </Button>
          </FormActions>
        </DialogContent>
      </Dialog>
    </section>
  );
}
