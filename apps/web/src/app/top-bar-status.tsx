// Top-bar status cluster: the worker health LED (md+ only). Unrealised P/L moved
// into the trading ticker (TopBarTicker), so it is no longer duplicated here. The
// global emergency stop lives on the Account page (reachable on desktop via the
// sidebar/header Account link and on mobile via the bottom nav).

import { useQuery } from '@tanstack/react-query';

import { fetchStatus, statusQueryKey } from '@/app/status-api';
import { classifyBuild } from '@/app/status-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip';
import { cn } from '@/shared/lib/cn';
import { t } from '@/shared/lib/i18n';

const POLL_MS = 30_000;

/** Health LED for the top bar, derived from the same /status poll the bottom
 * status bar uses. Worker down is the loud state; build skew/lag is a calm
 * amber "restart needed"; otherwise a quiet green "bot live". */
function HealthLed() {
  const q = useQuery({
    queryKey: statusQueryKey(),
    queryFn: fetchStatus,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });
  // No data yet (loading or the poll failed): render nothing rather than a
  // false verdict — the bottom bar already degrades the same way.
  if (!q.data) return null;
  const verdict = classifyBuild(q.data);
  const state =
    q.data.worker === null
      ? { label: t('topbar.health.down'), dot: 'bg-danger', text: 'text-danger' }
      : verdict.tone === 'ok'
        ? {
            label: t('topbar.health.live'),
            dot: 'bg-success',
            text: 'text-muted-fg',
          }
        : {
            label: t('topbar.health.restart'),
            dot: 'bg-warning',
            text: 'text-warning',
          };
  const chip = (
    <span
      data-testid="topbar-health"
      className={cn(
        'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider',
        state.text,
      )}
    >
      <span className={cn('inline-block h-1.5 w-1.5 rounded-full', state.dot)} aria-hidden />
      {state.label}
    </span>
  );
  if (verdict.sentences.length === 0) return chip;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent>
        <div className="flex max-w-xs flex-col gap-1">
          {verdict.sentences.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The header's status cluster: the worker-health LED, shown md+ only (the phone
 * keeps its bottom nav and per-page detail).
 */
export function TopBarStatus() {
  return (
    <div className="hidden shrink-0 items-center gap-3 md:flex" data-testid="topbar-status">
      <HealthLed />
    </div>
  );
}
