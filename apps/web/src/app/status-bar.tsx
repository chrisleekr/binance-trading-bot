import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import type { StatusResponse } from '@app/contracts';

import { fetchStatus, statusQueryKey } from '@/app/status-api';
import { Badge } from '@/shared/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/shared/components/ui/tooltip';
import { useTimezone } from '@/shared/context/timezone-context';
import { cn } from '@/shared/lib/cn';
import { formatClock, formatInstant } from '@/shared/lib/format-time';

const POLL_MS = 30_000;

/** First 7 chars — the short SHA the operator recognises from git/CI. */
function short(sha: string): string {
  return sha.slice(0, 7);
}

type BuildTone = 'skew' | 'lag' | 'ok';

interface BuildVerdict {
  /** Live-worker build tone only (skew / migration-lag / down). Study is separate. */
  readonly tone: BuildTone;
  /** `<sha7|down>` label for the worker side. */
  readonly workerLabel: string;
  /** `'down'` when the study (backtest) worker is absent, else null (healthy — omitted from the pill). */
  readonly studyLabel: string | null;
  /** Live-worker explanation(s) for the tooltip. */
  readonly sentences: readonly string[];
  /** Study-worker explanation, kept apart so the trading-health LED ignores it. */
  readonly studySentence: string | null;
}

/**
 * Classify api/worker build state for the status bar.
 *
 *  - `skew`  — both SHAs are known and differ (api/worker on different code).
 *  - `lag`   — worker is down, OR booted before the latest DB migration.
 *  - `ok`    — aligned (or not enough info to warn).
 *
 * `tone` covers the LIVE worker only. The study (backtest) worker is reported
 * separately via `studyLabel`/`studySentence`: a down study process pauses
 * backtests but says nothing about live-trading health, so the top-bar trading
 * LED (which reads `tone`) must not flip on it; only the bottom build bar marks
 * it. Pure so the badge/tooltip branches are unit-testable without rendering.
 */
export function classifyBuild(status: StatusResponse): BuildVerdict {
  const { api, worker, study, db } = status;

  const studyLabel = study === null ? 'down' : null;
  const studySentence =
    study === null
      ? 'The backtest worker is not running — backtests are paused until it restarts.'
      : null;

  if (worker === null) {
    return {
      tone: 'lag',
      workerLabel: 'down',
      studyLabel,
      sentences: ['The worker is not running — start it to resume trading.'],
      studySentence,
    };
  }

  const sentences: string[] = [];
  let tone: BuildTone = 'ok';

  const known = api.sha !== 'unknown' && worker.sha !== 'unknown';
  if (known && api.sha !== worker.sha) {
    tone = 'skew';
    sentences.push('API and worker are running different code — restart the worker to sync.');
  }

  const latest = db.latestMigrationAppliedAt;
  // Compare as epoch ms, not ISO strings: lexicographic ordering is only
  // correct while both sides stay canonical toISOString() UTC, so a future
  // format change on either producer cannot silently invert the comparison.
  if (latest !== null && Date.parse(worker.bootedAt) < Date.parse(latest)) {
    if (tone === 'ok') tone = 'lag';
    sentences.push(
      'The worker started before the latest database change — restart it to pick up the schema.',
    );
  }

  return { tone, workerLabel: short(worker.sha), studyLabel, sentences, studySentence };
}

const TONE_VARIANT: Record<Exclude<BuildTone, 'ok'>, 'danger' | 'warning'> = {
  skew: 'danger',
  lag: 'warning',
};

/*
 * Slim status bar pinned to the bottom of the shell: a session indicator, a
 * build-status pill (api/worker SHAs with a skew/lag warning), and a live clock
 * in the operator's configured zone. Desktop only; mobile uses the bottom nav
 * for the same edge.
 */
export function StatusBar({ className }: { className?: string }) {
  const timeZone = useTimezone();
  // Tick on the instant, not the formatted string: the zone can change under us
  // (the settings query resolves after first paint) and the label must follow.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Graceful on error/loading: render nothing for the build segment rather than
  // blocking the bar. A failed status poll is a cosmetic gap, never a fault.
  const q = useQuery({
    queryKey: statusQueryKey(),
    queryFn: fetchStatus,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });

  return (
    <footer
      className={cn(
        'border-border bg-bg text-muted-fg flex h-6 shrink-0 items-center justify-between gap-4 border-t px-4 text-xs',
        className,
      )}
    >
      <span className="flex items-center gap-1.5">
        <span className="bg-success inline-block h-1.5 w-1.5 rounded-full" aria-hidden />
        Signed in
      </span>
      <BuildStatus status={q.data} timeZone={timeZone} />
      <span className="font-mono tabular-nums" data-testid="status-clock">
        {formatClock(now, timeZone)}
      </span>
    </footer>
  );
}

function BuildStatus({
  status,
  timeZone,
}: {
  status: StatusResponse | undefined;
  timeZone: string;
}) {
  if (!status) return null;
  const verdict = classifyBuild(status);
  // The bottom build bar (unlike the trading LED) does mark a down study worker:
  // warning, unless a more severe live-worker tone already applies.
  const variant =
    verdict.tone !== 'ok' ? TONE_VARIANT[verdict.tone] : verdict.studyLabel ? 'warning' : undefined;
  // Study is shown inline only when down (the actionable state); a healthy study
  // worker stays in the tooltip to keep the bar uncluttered on 375px.
  const text =
    `api ${short(status.api.sha)} · worker ${verdict.workerLabel}` +
    (verdict.studyLabel ? ` · study ${verdict.studyLabel}` : '');

  const pill =
    variant === undefined ? (
      <span className="font-mono" data-testid="build-status">
        {text}
      </span>
    ) : (
      // normal-case: git SHAs are lowercase hex — the badge case transform
      // would misrender them.
      <Badge variant={variant} className="font-mono normal-case" data-testid="build-status">
        {text}
      </Badge>
    );

  const lines = [
    `api ${status.api.sha} (booted ${formatInstant(status.api.bootedAt, timeZone)})`,
    status.worker
      ? `worker ${status.worker.sha} (booted ${formatInstant(status.worker.bootedAt, timeZone)})`
      : 'worker down',
    status.study
      ? `study ${status.study.sha} (booted ${formatInstant(status.study.bootedAt, timeZone)})`
      : 'study worker down',
    ...verdict.sentences,
    ...(verdict.studySentence ? [verdict.studySentence] : []),
  ];

  return (
    <Tooltip>
      <TooltipTrigger asChild>{pill}</TooltipTrigger>
      <TooltipContent>
        <div className="flex max-w-xs flex-col gap-1">
          {lines.map((line) => (
            <span key={line}>{line}</span>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
