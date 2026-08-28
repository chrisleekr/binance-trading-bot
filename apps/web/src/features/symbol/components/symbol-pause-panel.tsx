// SymbolPausePanel engages the per-symbol kill-switch. Mounts only when the symbol is not already
// disabled; SymbolDisableBanner owns the resume path. A compact trigger opens a modal that POSTs a
// SymbolDisableRequest with a required reason and a preset TTL.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { ActionBanner, type ActionBannerState } from '@/shared/components/action-banner';
import { FormActions } from '@/shared/components/form-actions';
import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { errorMessage } from '@/shared/lib/api';
import { engageDisable, symbolStateQueryKey } from '@/features/symbol/api/symbol';
import { Select } from '@/shared/components/ui/select';

const HOUR = 3600;

// Preset TTLs only. The disable Redis key carries a TTL and the API caps it
// at 7 days, so a free-form seconds input would just invite invalid values.
const DURATIONS: readonly { value: number; label: string }[] = [
  { value: HOUR, label: '1 hour' },
  { value: 6 * HOUR, label: '6 hours' },
  { value: 24 * HOUR, label: '1 day' },
  { value: 3 * 24 * HOUR, label: '3 days' },
  { value: 7 * 24 * HOUR, label: '7 days' },
];

/**
 * Per-symbol pause entry in the symbol workspace trade tab, below Force trigger.
 * The trade tab mounts it only while `state.disable` is null; once a disable is live the
 * banner in the header carries the countdown and the resume action instead.
 * A button opens a modal that collects the reason and duration and fires the
 * disable in one step.
 */
export function SymbolPausePanel({
  profileId,
  symbol,
}: {
  readonly profileId: string;
  readonly symbol: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [ttl, setTtl] = useState<number>(HOUR);
  const [banner, setBanner] = useState<ActionBannerState | null>(null);
  const queryClient = useQueryClient();
  // `disable.isPending` only flips on the next render, so two clicks in the
  // same tick both observe the old value and both fire the mutation. The ref
  // flips synchronously and is the real guard, matching ForceTriggerPanel.
  const firingRef = useRef(false);

  const trimmedReason = reason.trim();

  const disable = useMutation({
    mutationFn: () => engageDisable(profileId, symbol, { reason: trimmedReason, ttlSeconds: ttl }),
    onSuccess: async () => {
      // The success banner is transient: once the symbol-state refetch lands,
      // the route unmounts this panel and SymbolDisableBanner takes over as
      // the live confirmation. The banner only matters if that refetch lags.
      setBanner({ kind: 'ok', message: 'Symbol trading paused.' });
      setReason('');
      setOpen(false);
      firingRef.current = false;
      await queryClient.invalidateQueries({ queryKey: symbolStateQueryKey(profileId, symbol) });
    },
    onError: (err) => {
      firingRef.current = false;
      setBanner({ kind: 'err', message: errorMessage(err) });
    },
  });

  return (
    <section className="space-y-2" data-testid="symbol-pause-panel">
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          setBanner(null);
          setOpen(true);
        }}
        data-testid="symbol-pause-open"
      >
        Pause trading
      </Button>

      <ActionBanner banner={banner} />

      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pause trading for {symbol}?</DialogTitle>
            <DialogDescription>
              Freezes the strategy&apos;s buy and sell decisions for {symbol} until the timer
              expires or you resume it. Open orders are unaffected; resume early from the banner
              that appears once the pause is live.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            <Label htmlFor="pause-reason">Reason</Label>
            <Input
              id="pause-reason"
              value={reason}
              maxLength={256}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why pause this symbol"
              data-testid="pause-reason"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="pause-duration">Duration</Label>
            <Select
              id="pause-duration"
              className="w-full"
              value={ttl}
              onChange={(e) => setTtl(Number(e.target.value))}
              data-testid="pause-duration"
            >
              {DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </Select>
          </div>

          <FormActions>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              data-testid="pause-submit"
              disabled={trimmedReason === '' || disable.isPending}
              aria-describedby={trimmedReason === '' ? 'pause-reason-required' : undefined}
              onClick={() => {
                if (firingRef.current || disable.isPending) return;
                firingRef.current = true;
                disable.mutate();
              }}
            >
              {disable.isPending ? 'Pausing…' : 'Pause trading'}
            </Button>
          </FormActions>
          {trimmedReason === '' ? (
            <p
              id="pause-reason-required"
              className="text-right text-xs text-muted-fg"
              data-testid="pause-reason-required"
            >
              Enter a reason to enable.
            </p>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
