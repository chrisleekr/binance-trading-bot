// SymbolDisableBanner — surfaces the per-symbol kill-switch when present.
//
// `disable` arrives on `SymbolStateResponse` as `{ ttlSeconds, since, reason }`
// derived from the `disable-action:<symbol>` Redis key plus its TTL. We freeze
// the server-side TTL on mount and decrement locally so the UI doesn't hammer
// the API every second; a 5s react-query refetch already covers the case
// where the operator extends the disable from elsewhere.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import { errorMessage } from '@/shared/lib/api';
import { releaseDisable, symbolStateQueryKey } from '@/features/symbol/api/symbol';

import type { SymbolStateResponse } from '@app/contracts';

interface DisableBannerProps {
  readonly profileId: string;
  readonly symbol: string;
  readonly disable: NonNullable<SymbolStateResponse['disable']>;
  /** Test seam — defaults to Date.now. */
  readonly clock?: () => number;
}

/** Format `seconds` as H:MM:SS or M:SS for the countdown badge. */
export const formatTtl = (seconds: number): string => {
  if (seconds <= 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

/**
 * Per-symbol kill-switch banner. Mounts only when `state.disable` is non-null
 * (the route passes `null` to short-circuit the panel). The Resume action
 * stays gated by the mutation's pending state to keep accidental
 * double-clicks from racing the API.
 */
export function SymbolDisableBanner({
  profileId,
  symbol,
  disable,
  clock = Date.now,
}: DisableBannerProps): React.JSX.Element {
  const queryClient = useQueryClient();
  // Freeze the server's TTL plus the wall-clock at which we received it.
  // The anchor reseeds whenever the parent passes a new `disable` (e.g. the
  // 5s state refetch picks up an extension applied from another tab) so
  // the countdown tracks the latest server-side TTL instead of decaying
  // toward the original expiry.
  const anchorRef = useRef({ baseMs: clock(), baseTtl: disable.ttlSeconds });
  useEffect(() => {
    anchorRef.current = { baseMs: clock(), baseTtl: disable.ttlSeconds };
  }, [disable.ttlSeconds, disable.since, clock]);

  const [now, setNow] = useState(() => clock());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(clock()), 1_000);
    return (): void => window.clearInterval(handle);
  }, [clock]);

  const elapsedS = Math.floor((now - anchorRef.current.baseMs) / 1_000);
  const remaining = Math.max(0, anchorRef.current.baseTtl - elapsedS);
  // `ttlSeconds: 0` is the API's "key exists without TTL" recovery surface
  // (see /state handler). Resume is the *only* way out of that state, so
  // the button must stay enabled even though `remaining === 0`.
  const canResume = disable.ttlSeconds === 0 || remaining > 0;

  const release = useMutation({
    mutationFn: () => releaseDisable(profileId, symbol),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: symbolStateQueryKey(profileId, symbol) });
    },
  });

  const errMsg = release.error ? errorMessage(release.error) : null;

  return (
    <Alert variant="warning" data-testid="symbol-disable-banner">
      <AlertTitle>Symbol disabled</AlertTitle>
      <AlertDescription className="space-y-2">
        <div>
          {disable.reason ? `Reason: ${disable.reason}.` : 'No reason recorded.'} Disabled since{' '}
          <span className="font-mono">{disable.since}</span>.
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs">
            Auto-resume in{' '}
            <span data-testid="symbol-disable-ttl" className="font-mono">
              {formatTtl(remaining)}
            </span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="default"
            disabled={!canResume || release.isPending}
            onClick={() => release.mutate()}
            data-testid="symbol-disable-resume"
          >
            {release.isPending ? 'Resuming…' : 'Resume now'}
          </Button>
        </div>
        {errMsg ? <div className="text-xs text-danger">⚠ {errMsg}</div> : null}
      </AlertDescription>
    </Alert>
  );
}
