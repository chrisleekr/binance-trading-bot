// Profile log viewer: the filter bar, the row list with expandable context,
// copy/export, and the deep-capture arming control.
//
// This is the "why did it do that" surface. Every row carries the structured
// `ctx` the worker recorded, rendered as raw JSON rather than a prose summary —
// the reader is whoever is debugging, and a summary is exactly the information
// they came here to get past.
//
// Filter state lives in this component rather than the URL: unlike the audit
// tab's event filter, a log filter is a scratch tool used inside one sitting,
// and putting a free-text search into the address bar would put pasted order
// ids and rejection reasons into browser history.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { TableSkeleton } from '@/shared/components/page-skeleton';
import { cn } from '@/shared/lib/cn';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { formatInstant } from '@/shared/lib/format-time';
import { useTimezone } from '@/shared/context/timezone-context';
import {
  emptyLogFilter,
  fetchProfileLogSymbols,
  fetchProfileLogs,
  profileLogsExportUrl,
  profileLogsQueryKey,
  type LogFilter,
} from '@/features/profile/api/profile-logs';
import {
  fetchRetentionConfig,
  patchRetentionConfig,
  retentionConfigQueryKey,
} from '@/features/account/api/retention-config';

import { ActionLogLevel, type ActionLogPageEntry } from '@app/contracts';

/**
 * Chips, one per level. Derived from the contract enum, which is already
 * declared in severity order, so the chips read as an escalation and a level
 * added to the contract cannot go unfilterable here.
 */
const LEVELS = ActionLogLevel.options;

const LEVEL_VARIANT: Record<string, 'secondary' | 'default' | 'warning' | 'danger'> = {
  debug: 'secondary',
  info: 'default',
  warn: 'warning',
  error: 'danger',
};

/**
 * Quick time windows. "All" omits the bound entirely rather than sending a very
 * old `from`, so the query stays a plain index scan to the retention horizon.
 */
const RANGES: readonly { readonly label: string; readonly hours: number | null }[] = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: 'All', hours: null },
];

/** Window the view opens on. Also the initial `from`, so the selector and the query agree. */
const DEFAULT_RANGE_HOURS = 24;

const since = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

/** Minutes an operator can arm deep capture for. Bounded by the contract at 24h. */
const CAPTURE_MINUTES: readonly number[] = [15, 60, 240, 1440];

const captureLabel = (minutes: number): string =>
  minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`;

interface PageState {
  readonly cursor: string | null;
  /** Cursors already visited, so Prev retraces the path a keyset reader cannot compute. */
  readonly history: readonly (string | null)[];
}

const FIRST_PAGE: PageState = { cursor: null, history: [] };

/** Copy text, reporting the outcome. Clipboard access rejects in an insecure context. */
const copy = async (text: string, what: string): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error('Clipboard unavailable. Select the text manually.');
  }
};

/** One log row, rendered as JSON exactly as the export writes it. */
const rowJson = (row: ActionLogPageEntry): string =>
  JSON.stringify({
    time: row.time,
    level: row.level,
    symbol: row.symbol,
    msg: row.msg,
    ctx: row.ctx,
  });

function LogRow({
  row,
  timeZone,
}: {
  readonly row: ActionLogPageEntry;
  readonly timeZone: string;
}): React.JSX.Element {
  const hasCtx = row.ctx !== undefined && row.ctx !== null;
  return (
    <li className="border-b border-border px-3 py-2 last:border-b-0" data-testid="log-row">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="w-44 shrink-0 font-mono text-xs text-muted-fg tabular-nums">
          {formatInstant(row.time, timeZone)}
        </span>
        <Badge variant={LEVEL_VARIANT[row.level] ?? 'secondary'}>{row.level}</Badge>
        {row.symbol !== null ? (
          <span className="font-mono text-xs text-fg">{row.symbol}</span>
        ) : null}
        <span className="min-w-0 flex-1 text-xs break-words text-fg">{row.msg}</span>
        <button
          type="button"
          onClick={() => void copy(rowJson(row), 'Row')}
          className="shrink-0 text-xs text-muted-fg underline hover:text-fg"
          data-testid="log-row-copy"
        >
          Copy
        </button>
      </div>
      {hasCtx ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted-fg">Context</summary>
          {/* Raw JSON, not a rendered key/value list: the reader is debugging,
              and a prettified projection is where a missing field hides. */}
          <pre
            className="mt-1 max-h-64 overflow-auto rounded bg-bg p-2 font-mono text-xs text-muted-fg"
            data-testid="log-row-ctx"
          >
            {JSON.stringify(row.ctx, null, 2)}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

/**
 * Deep-capture control. Arming writes EVERY tick of this profile as a `debug`
 * row, which is orders of magnitude more volume than the default on-change
 * rows — so it is always a bounded window, and the server, not this component,
 * owns the deadline.
 */
function DeepCaptureControl({ profileId }: { readonly profileId: string }): React.JSX.Element {
  const qc = useQueryClient();
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const config = useQuery({
    queryKey: retentionConfigQueryKey,
    queryFn: fetchRetentionConfig,
    // The window lapses on its own, so the armed banner has to stop being true
    // without an operator action.
    refetchInterval: 30_000,
  });

  const capture = config.data?.debugCapture ?? null;
  const armedHere = capture !== null && capture.profileId === profileId;
  const armedElsewhere = capture !== null && capture.profileId !== profileId;

  const submit = async (body: Parameters<typeof patchRetentionConfig>[0]): Promise<void> => {
    setBusy(true);
    try {
      qc.setQueryData(retentionConfigQueryKey, await patchRetentionConfig(body));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update capture.');
    } finally {
      setBusy(false);
    }
  };

  if (armedHere) {
    return (
      <div className="flex items-center gap-2" data-testid="deep-capture-armed">
        <Badge variant="warning">
          Capturing until {new Date(capture.until).toLocaleTimeString()}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void submit({ debugCapture: null })}
        >
          Stop
        </Button>
      </div>
    );
  }

  // Only one profile can be captured at a time — the worker reads a single armed
  // profile id — so arming here ends whatever is running elsewhere. Naming that
  // in a notice is not enough on its own: the button still works, and the
  // operator whose investigation is being ended is usually the same person, at
  // another tab, who has forgotten it was armed.
  const arm = (): void => {
    if (
      armedElsewhere &&
      !window.confirm(
        'Another profile is being captured. Arming here stops that capture — its remaining window is lost. Continue?',
      )
    ) {
      return;
    }
    void submit({ debugCapture: { profileId, minutes } });
  };

  return (
    <div className="flex items-center gap-2" data-testid="deep-capture-control">
      {armedElsewhere ? (
        <span className="text-xs text-muted-fg">Another profile is being captured.</span>
      ) : null}
      <select
        value={minutes}
        onChange={(e) => setMinutes(Number(e.target.value))}
        aria-label="Capture duration"
        className="rounded border border-border bg-bg-elevated px-2 py-1 text-xs text-fg"
      >
        {CAPTURE_MINUTES.map((m) => (
          <option key={m} value={m}>
            {captureLabel(m)}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={arm}
        data-testid="deep-capture-arm"
        title="Records every tick of this profile as a debug row until the window lapses."
      >
        Capture every tick
      </Button>
    </div>
  );
}

/**
 * Paged log reader for one profile. Owns the filter, the cursor stack, and the
 * copy/export actions; the deep-capture control rides along in the header
 * because arming it is what an operator does when this view did not have enough
 * detail.
 */
export function LogViewerPanel({ profileId }: { readonly profileId: string }): React.JSX.Element {
  const timeZone = useTimezone();
  const accountId = useActiveAccountId() ?? '';
  // Seeded with the default window rather than an unbounded filter: the selector
  // renders 24h from the first paint, and a filter without the matching `from`
  // would show rows older than the window the operator is being told they see.
  const [filter, setFilter] = useState<LogFilter>(() => ({
    ...emptyLogFilter,
    from: since(DEFAULT_RANGE_HOURS),
  }));
  const [q, setQ] = useState('');
  const [rangeHours, setRangeHours] = useState<number | null>(DEFAULT_RANGE_HOURS);
  const [page, setPage] = useState<PageState>(FIRST_PAGE);

  // Any filter change invalidates the cursor stack: a cursor is a position in a
  // specific result set, and reusing it across filters pages into rows the new
  // filter never selected.
  const apply = (next: LogFilter): void => {
    setFilter(next);
    setPage(FIRST_PAGE);
  };

  const symbols = useQuery({
    queryKey: ['profile-log-symbols', profileId],
    queryFn: () => fetchProfileLogSymbols(profileId),
    staleTime: 60_000,
  });

  const list = useQuery({
    queryKey: profileLogsQueryKey(profileId, filter, page.cursor),
    queryFn: () => fetchProfileLogs(profileId, filter, page.cursor),
    // Rows arrive continuously from the drainer; a stale head is what makes an
    // operator think the bot stopped acting.
    refetchInterval: 15_000,
  });

  const items = list.data?.items ?? [];
  const nextCursor = list.data?.nextCursor ?? null;

  const toggleLevel = (level: string): void => {
    const has = filter.levels.includes(level);
    apply({
      ...filter,
      levels: has ? filter.levels.filter((l) => l !== level) : [...filter.levels, level],
    });
  };

  const setRange = (hours: number | null): void => {
    setRangeHours(hours);
    const { from: _dropped, ...rest } = filter;
    apply(hours === null ? rest : { ...rest, from: since(hours) });
  };

  return (
    <div className="space-y-4" data-testid="log-viewer">
      <div className="flex flex-wrap items-center gap-2">
        {LEVELS.map((level) => {
          const active = filter.levels.includes(level);
          return (
            <button
              key={level}
              type="button"
              onClick={() => toggleLevel(level)}
              data-testid={`log-level-${level}`}
              aria-pressed={active}
              className={cn(
                'rounded-full border border-border px-2.5 py-0.5 text-xs uppercase',
                active ? 'bg-accent text-accent-fg' : 'text-muted-fg hover:text-fg',
              )}
            >
              {level}
            </button>
          );
        })}

        <select
          value={filter.symbols[0] ?? ''}
          onChange={(e) => apply({ ...filter, symbols: e.target.value ? [e.target.value] : [] })}
          aria-label="Symbol"
          data-testid="log-symbol-filter"
          className="rounded border border-border bg-bg-elevated px-2 py-1 text-xs text-fg"
        >
          <option value="">All symbols</option>
          {(symbols.data?.symbols ?? []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>

        <select
          value={rangeHours === null ? '' : String(rangeHours)}
          onChange={(e) => setRange(e.target.value === '' ? null : Number(e.target.value))}
          aria-label="Time range"
          data-testid="log-range-filter"
          className="rounded border border-border bg-bg-elevated px-2 py-1 text-xs text-fg"
        >
          {RANGES.map((r) => (
            <option key={r.label} value={r.hours === null ? '' : String(r.hours)}>
              {r.label}
            </option>
          ))}
        </select>

        {/* Search is applied on submit, not per keystroke: each apply resets to
            page one and re-queries, and doing that per character would hammer
            the reader for results nobody reads. */}
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = q.trim();
            const { q: _dropped, ...rest } = filter;
            apply(trimmed === '' ? rest : { ...rest, q: trimmed });
          }}
        >
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search message"
            aria-label="Search message"
            data-testid="log-search"
            className="h-7 w-40 text-xs"
          />
          <Button type="submit" variant="ghost" size="sm">
            Search
          </Button>
        </form>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <DeepCaptureControl profileId={profileId} />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={items.length === 0}
            onClick={() => void copy(items.map(rowJson).join('\n'), 'Visible rows')}
            data-testid="log-copy-visible"
          >
            Copy page
          </Button>
          {/* The export carries the SAME filter as the view. An export that
              silently widened it would have the operator draw conclusions from
              a file that does not match what they were reading. */}
          <Button asChild variant="default" size="sm">
            <a
              href={profileLogsExportUrl(accountId, profileId, filter)}
              download
              data-testid="log-export-link"
              title="Downloads every row matching the current filter as NDJSON."
            >
              Export NDJSON
            </a>
          </Button>
        </div>
      </div>

      {list.isLoading ? <TableSkeleton /> : null}

      {list.error ? (
        <Alert variant="danger">
          <AlertTitle>Failed to load logs</AlertTitle>
          <AlertDescription>
            {list.error instanceof Error ? list.error.message : 'unknown'}
          </AlertDescription>
        </Alert>
      ) : null}

      {list.isSuccess && items.length === 0 ? (
        <p className="text-sm text-muted-fg" data-testid="log-empty">
          {page.history.length > 0
            ? 'No more rows past this point. Go back with Newer.'
            : 'No log rows match this filter. Widen the time range, or arm capture to record every tick.'}
        </p>
      ) : null}

      {items.length > 0 ? (
        <ul className="rounded-md border border-border" data-testid="log-list">
          {items.map((row) => (
            <LogRow key={row.id} row={row} timeZone={timeZone} />
          ))}
        </ul>
      ) : null}

      {/* Also shown on an empty page reached by paging: rows can be pruned or
          drop out of the filter between requests, and hiding the pager there
          strands the operator with no way back to the page they came from. */}
      {items.length > 0 || page.history.length > 0 ? (
        <div className="flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="default"
            disabled={page.history.length === 0}
            onClick={() =>
              setPage((p) => ({
                cursor: p.history.at(-1) ?? null,
                history: p.history.slice(0, -1),
              }))
            }
          >
            ‹ Newer
          </Button>
          <span className="font-mono text-xs text-muted-fg tabular-nums">
            Page {page.history.length + 1}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="default"
            disabled={nextCursor === null}
            onClick={() =>
              setPage((p) =>
                nextCursor === null ? p : { cursor: nextCursor, history: [...p.history, p.cursor] },
              )
            }
          >
            Older ›
          </Button>
        </div>
      ) : null}
    </div>
  );
}
