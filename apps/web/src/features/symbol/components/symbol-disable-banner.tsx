// SymbolDisableBanner — surfaces the per-symbol kill-switch when present.
//
// `disable` arrives on `SymbolStateResponse` as `{ ttlSeconds, since, reason }` derived from the `disable-action:<symbol>` Redis key plus its TTL. We freeze the server-side TTL on mount and decrement locally so the UI does not request an update every second. A new disable write carries a new `since`, which re-seeds the countdown without remounting on ordinary TTL refreshes.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

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
export function SymbolDisableBanner({ disable, ...props }: DisableBannerProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const release = useMutation({
    mutationFn: () => releaseDisable(props.profileId, props.symbol),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: symbolStateQueryKey(props.profileId, props.symbol),
      });
    },
  });

  return (
    <SymbolDisableBannerBody
      key={disable.since}
      disable={disable}
      {...(props.clock ? { clock: props.clock } : {})}
      releaseError={release.error}
      isResuming={release.isPending}
      onResume={() => release.mutate()}
    />
  );
}

interface DisableBannerBodyProps {
  readonly disable: DisableBannerProps['disable'];
  readonly clock?: () => number;
  readonly releaseError: unknown;
  readonly isResuming: boolean;
  readonly onResume: () => void;
}

function SymbolDisableBannerBody({
  disable,
  clock = Date.now,
  releaseError,
  isResuming,
  onResume,
}: DisableBannerBodyProps): React.JSX.Element {
  // Freeze the server's TTL plus the wall-clock at which we received it. The parent keys this body by `since`, so a new disable window re-seeds the anchor while an ordinary TTL refresh preserves the DOM and countdown phase.
  const [anchor] = useState(() => ({ baseMs: clock(), baseTtl: disable.ttlSeconds }));

  const [now, setNow] = useState(() => clock());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(clock()), 1_000);
    return (): void => window.clearInterval(handle);
  }, [clock]);

  const elapsedS = Math.floor((now - anchor.baseMs) / 1_000);
  const remaining = Math.max(0, anchor.baseTtl - elapsedS);
  // `ttlSeconds: 0` is the API's "key exists without TTL" recovery surface
  // (see /state handler). Resume is the *only* way out of that state, so
  // the button must stay enabled even though `remaining === 0`.
  const canResume = disable.ttlSeconds === 0 || remaining > 0;

  const errMsg = releaseError ? errorMessage(releaseError) : null;

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
            disabled={!canResume || isResuming}
            onClick={onResume}
            data-testid="symbol-disable-resume"
          >
            {isResuming ? 'Resuming…' : 'Resume now'}
          </Button>
        </div>
        {errMsg ? <div className="text-xs text-danger">⚠ {errMsg}</div> : null}
      </AlertDescription>
    </Alert>
  );
}
