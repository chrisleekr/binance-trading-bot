// Persistent "is my money OK right now" strip, shown on every viewport directly
// under the header. Answers three things the operator otherwise has to assemble:
// is the worker alive (the desktop-only TopBarStatus left mobile blind), is
// anything silently paused (no halt aggregation existed anywhere), and how is
// today going. Polls /account/health; the server does the money math.

import { useQuery } from '@tanstack/react-query';

import { accountHealthQueryKey, fetchAccountHealth } from '@/app/account-health-api';
import { PnlValue } from '@/shared/components/pnl-value';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip';
import { cn } from '@/shared/lib/cn';

const POLL_MS = 15_000;

const HALT_LABEL: Record<'daily-loss', string> = {
  'daily-loss': 'daily loss limit',
};

/** Slim chip: a coloured dot + label, the shared status-chip look. */
function Chip({
  tone,
  label,
  testId,
}: {
  tone: 'ok' | 'warn' | 'danger';
  label: string;
  testId?: string;
}): React.JSX.Element {
  const dot = tone === 'ok' ? 'bg-success' : tone === 'warn' ? 'bg-warning' : 'bg-danger';
  const text = tone === 'ok' ? 'text-muted-fg' : tone === 'warn' ? 'text-warning' : 'text-danger';
  return (
    <span
      data-testid={testId}
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-[11px] font-semibold tracking-wider uppercase',
        text,
      )}
    >
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full', dot)} aria-hidden />
      {label}
    </span>
  );
}

/**
 * The account-health bar. Renders nothing until the first poll resolves (no
 * false verdict, matching the other status surfaces). Live-mode realized P/L
 * only in the headline; practice P/L never appears here.
 */
export function AccountHealthBar(): React.JSX.Element | null {
  const q = useQuery({
    queryKey: accountHealthQueryKey(),
    queryFn: fetchAccountHealth,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });

  if (!q.data) return null;
  const { worker, halts, todayRealized, approachingLimit } = q.data;
  const liveToday = todayRealized.filter((t) => t.binanceMode === 'live');

  const workerChip =
    worker.status === 'live' ? (
      <Chip tone="ok" label="Bot live" testId="account-health-worker" />
    ) : (
      <Chip tone="danger" label="Bot down — restart worker" testId="account-health-worker" />
    );

  return (
    <div
      data-testid="account-health-bar"
      className="flex h-7 shrink-0 items-center gap-3 overflow-x-auto border-b border-border bg-bg-elevated px-3"
    >
      {workerChip}

      {halts.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Chip tone="warn" label={`${halts.length} paused`} testId="account-health-halts" />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex max-w-xs flex-col gap-1">
              {halts.map((h) => (
                <span key={`${h.profileId}-${h.kind}`}>
                  {h.name} — {HALT_LABEL[h.kind]}
                </span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      ) : null}

      {approachingLimit.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Chip
                tone="warn"
                label={`${approachingLimit.length} near limit`}
                testId="account-health-approaching"
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <div className="flex max-w-xs flex-col gap-1">
              {approachingLimit.map((a) => (
                <span key={a.profileId}>
                  {a.name}: {a.lossQuote} of {a.limitQuote} limit
                </span>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      ) : null}

      {liveToday.length > 0 ? (
        <span
          className="ml-auto flex shrink-0 items-center gap-2"
          data-testid="account-health-today"
        >
          <span className="text-[11px] font-semibold tracking-wider text-muted-fg uppercase">
            Today
          </span>
          {liveToday.map((t) => (
            <PnlValue
              key={`${t.quoteAsset}-${t.binanceMode}`}
              value={t.realizedQuote}
              unit={t.quoteAsset}
              className="text-xs"
            />
          ))}
        </span>
      ) : null}
    </div>
  );
}
