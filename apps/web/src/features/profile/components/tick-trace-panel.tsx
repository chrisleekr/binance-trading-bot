// Raw per-tick trace: a window straight onto the Redis audit stream the worker
// already writes on every tick.
//
// Nothing is written to serve this view, which is why it exists — it is the one
// surface with full per-tick fidelity that costs no storage. The trade is reach:
// the stream is trimmed to a fixed entry count across all of a profile's
// symbols, so a busy profile reaches back hours, not days. When the window has
// to outlive that, the answer is deep capture, not a bigger trim.
//
// Collapsed by default: it is an escalation from the Logs list, not the first
// thing to read, and expanding it issues the fetch.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Badge } from '@/shared/components/ui/badge';
import { Panel } from '@/shared/components/panel';
import { TableSkeleton } from '@/shared/components/page-skeleton';
import { formatInstant } from '@/shared/lib/format-time';
import { useTimezone } from '@/shared/context/timezone-context';
import { fetchTickTrace } from '@/features/profile/api/profile-logs';

/**
 * Raw trace reader for one profile, optionally narrowed to a symbol. Rendering
 * is deliberately unopinionated: the payload is the strategy's own audit block
 * merged with the executor's results, and projecting it into named fields here
 * is exactly how a newly-added field would go missing from the debug view.
 */
export function TickTracePanel({
  profileId,
  symbol,
}: {
  readonly profileId: string;
  readonly symbol: string | null;
}): React.JSX.Element {
  const timeZone = useTimezone();
  const [open, setOpen] = useState(false);
  // One window at a time rather than an accumulating list: this is an
  // escalation surface read in place, and a stream id names an exact position,
  // so walking back a window at a time is both simpler and unambiguous.
  const [before, setBefore] = useState<string | null>(null);

  const trace = useQuery({
    queryKey: ['tick-trace', profileId, symbol, before],
    queryFn: () => fetchTickTrace(profileId, symbol, before),
    // Only once expanded: the stream read is cheap but pointless while collapsed.
    enabled: open,
    // Only the newest window grows. A window pinned to a `before` id is a fixed
    // slice of the past, so re-reading it every 15s is load for no new rows.
    refetchInterval: open && before === null ? 15_000 : false,
  });

  const items = trace.data?.items ?? [];
  // Read off the unfiltered window, so a symbol filter that empties the page
  // still leaves somewhere to walk back to.
  const oldest = trace.data?.oldestStreamId ?? null;

  return (
    <Panel
      title="Raw tick trace"
      description="Every tick the worker recorded, straight from the in-memory stream. Reaches back as far as the stream's trim length, not the log retention window."
      collapsible
      defaultOpen={false}
      testId="tick-trace-panel"
      summaryTestId="tick-trace-toggle"
    >
      {/* Expanding the panel does not fetch; an explicit Load does. The Panel
          disclosure is a native <details>, whose open state React does not own,
          and inferring the fetch from it would mean a stray expand issues a
          stream read the operator never asked for. */}
      <div>
        {!open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-xs text-muted-fg underline hover:text-fg"
            data-testid="tick-trace-load"
          >
            Load trace
          </button>
        ) : null}

        {open && trace.isLoading ? <TableSkeleton /> : null}

        {trace.error ? (
          <Alert variant="danger">
            <AlertTitle>Failed to read the trace</AlertTitle>
            <AlertDescription>
              {trace.error instanceof Error ? trace.error.message : 'unknown'}
            </AlertDescription>
          </Alert>
        ) : null}

        {trace.isSuccess && items.length === 0 ? (
          <p className="text-sm text-muted-fg">
            {before === null
              ? 'No trace entries in the stream.'
              : 'No trace entries in this window.'}
          </p>
        ) : null}

        {items.length > 0 ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {items.map((entry) => (
              <li key={entry.streamId} className="px-3 py-2" data-testid="tick-trace-row">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="w-44 shrink-0 font-mono text-xs text-muted-fg tabular-nums">
                    {formatInstant(entry.ts, timeZone)}
                  </span>
                  {entry.symbol !== null ? (
                    <span className="font-mono text-xs text-fg">{entry.symbol}</span>
                  ) : null}
                  <Badge variant="secondary">{entry.event}</Badge>
                  {entry.decisionTypes.map((d) => (
                    <Badge key={d} variant="outline">
                      {d}
                    </Badge>
                  ))}
                  {entry.latencyMs !== null ? (
                    <span className="font-mono text-xs text-muted-fg tabular-nums">
                      {entry.latencyMs}ms
                    </span>
                  ) : null}
                </div>
                {entry.payload !== undefined && entry.payload !== null ? (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-muted-fg">Payload</summary>
                    <pre className="mt-1 max-h-72 overflow-auto rounded bg-bg p-2 font-mono text-xs text-muted-fg">
                      {JSON.stringify(entry.payload, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {open && oldest !== null ? (
          <div className="flex items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setBefore(oldest)}
              className="text-xs text-muted-fg underline hover:text-fg"
              data-testid="tick-trace-older"
            >
              Load older
            </button>
            {before !== null ? (
              <button
                type="button"
                onClick={() => setBefore(null)}
                className="text-xs text-muted-fg underline hover:text-fg"
                data-testid="tick-trace-newest"
              >
                Back to newest
              </button>
            ) : null}
          </div>
        ) : null}

        {trace.data?.truncated ? (
          // "Trimmed away" is a different fact from "nothing happened", and an
          // operator who conflates them concludes the bot was idle when the
          // record is simply gone.
          <p className="pt-2 text-xs text-muted-fg" data-testid="tick-trace-truncated">
            The stream is at its buffer limit, so ticks older than the earliest entry here have been
            dropped. Raise the trace buffer in Settings, or arm capture, to keep more.
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
