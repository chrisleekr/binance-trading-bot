// Worker ops-health panel: per-cron last-run status. The single-replica worker
// runs ~19 crons, most self-rescheduling (discovery, technicals, backups, the
// risk breakers); if one silently stalls, nothing surfaced it until a downstream
// screen went empty. This shows each cron's last run + outcome so a stall (an
// old timestamp) or a failure (an error badge) is visible at a glance.

import { useQuery } from '@tanstack/react-query';

import { fetchWorkerCrons, workerCronsQueryKey } from '@/features/account/api/worker-crons';
import { Panel } from '@/shared/components/panel';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { formatLastTick } from '@/shared/lib/format-tick';
import { cn } from '@/shared/lib/cn';
import { LoadingRows } from '@/shared/components/page-skeleton';

const POLL_MS = 30_000;

export function OpsHealthPanel(): React.JSX.Element {
  const q = useQuery({
    queryKey: workerCronsQueryKey,
    queryFn: fetchWorkerCrons,
    refetchInterval: POLL_MS,
    staleTime: POLL_MS,
  });

  const crons = q.data?.crons ?? [];
  const erroring = crons.filter((c) => c.status === 'error').length;

  return (
    <Panel
      title="Background jobs"
      description="When each scheduled job last ran. A long gap means it may have stalled."
      testId="ops-health-panel"
      actions={
        erroring > 0 ? (
          <span className="text-xs font-semibold tracking-wider text-danger uppercase">
            {erroring} failing
          </span>
        ) : null
      }
    >
      <div className="space-y-3">
        {q.isLoading ? <LoadingRows /> : null}

        {q.error ? (
          <Alert variant="danger">
            <AlertTitle>Could not load job status</AlertTitle>
            <AlertDescription>
              {q.error instanceof Error ? q.error.message : 'unknown error'}
            </AlertDescription>
          </Alert>
        ) : null}

        {q.data && crons.length === 0 ? (
          <p className="text-sm text-muted-fg">
            No job has reported yet. If the worker just started, this fills in within a minute; if
            it stays empty, the worker may be down.
          </p>
        ) : null}

        {crons.length > 0 ? (
          <ul className="divide-y divide-border">
            {crons.map((c) => (
              <li
                key={c.name}
                className="flex items-center justify-between gap-3 py-1.5 text-sm"
                data-testid={`cron-${c.name}`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'inline-block h-1.5 w-1.5 rounded-full',
                      c.status === 'ok' ? 'bg-success' : 'bg-danger',
                    )}
                    aria-hidden
                  />
                  <span className="font-mono text-xs text-fg">{c.name}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-fg">
                  {c.status === 'error' && c.error ? (
                    <span className="max-w-[16rem] truncate text-danger" title={c.error}>
                      {c.error}
                    </span>
                  ) : null}
                  <span>{formatLastTick(new Date(c.lastRunAtMs).toISOString())}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
