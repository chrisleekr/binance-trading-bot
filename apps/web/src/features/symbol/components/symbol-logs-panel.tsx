// SymbolLogsPanel — virtualised, WS-appended, ring-bounded action-log feed.
//
// The panel owns a single sorted-by-time array and reconciles three input
// streams against it:
//   1. Initial backfill via REST (a 24h window from `now`).
//   2. Live appends via the per-profile WS `logs` topic.
//   3. Older history via "Load older" — widens `from` and prepends the
//      result, de-duplicated by `time + msg`.
//
// Why not React Query for everything: live appends violate the cache-by-key
// model (we'd be mutating an array under a key on every frame), and a 1k
// ring buffer needs explicit eviction which Query doesn't do for us. Local
// state keeps the data flow honest.

import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { TableSkeleton } from '@/shared/components/page-skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/shared/components/ui/alert';
import { Button } from '@/shared/components/ui/button';
import {
  fetchSymbolLogs,
  symbolLogsQueryKey,
  SYMBOL_LOGS_INITIAL_WINDOW_MS,
  SYMBOL_LOGS_PAGE_WINDOW_MS,
  SYMBOL_LOGS_RING_CAP,
} from '@/features/symbol/api/symbol';

import type { SymbolLogEntry } from '@app/contracts';

/**
 * Identity for de-duplication. `time` is server-stamped to ms precision;
 * `level` and `msg` together cover the practical case where two rows share
 * a millisecond. The WS topic and REST endpoint do not carry a stable row
 * id, so the triple is the strongest non-synthetic key available.
 */
const keyOf = (entry: SymbolLogEntry): string => `${entry.time}::${entry.level}::${entry.msg}`;

/** Sort newest-first for display; stable so de-dup'd inserts don't shuffle. */
const compareDesc = (a: SymbolLogEntry, b: SymbolLogEntry): number =>
  a.time === b.time ? 0 : a.time < b.time ? 1 : -1;

/**
 * Append a live frame to a newest-first array, de-duplicated and capped at
 * {@link SYMBOL_LOGS_RING_CAP}. Returns the same array reference when the
 * frame is a duplicate so callers can short-circuit a re-render.
 */
export const appendLive = (
  current: readonly SymbolLogEntry[],
  next: SymbolLogEntry,
  cap: number = SYMBOL_LOGS_RING_CAP,
): readonly SymbolLogEntry[] => {
  const k = keyOf(next);
  for (const e of current) {
    if (keyOf(e) === k) return current;
  }
  // Live frames typically arrive newer than the current head; if the WS
  // delivers an out-of-order frame we still place it correctly.
  const merged = [next, ...current].sort(compareDesc);
  return merged.length > cap ? merged.slice(0, cap) : merged;
};

/**
 * Idempotent union used by the initial-load hydration and the resync path.
 * Folds REST rows into whatever the panel has already accumulated rather
 * than overwriting — the panel's live ring buffer is the source of truth
 * for entries that arrived between mount and the first REST resolution
 * (or between an invalidation and the refetch landing).
 */
export const mergeAll = (
  current: readonly SymbolLogEntry[],
  next: readonly SymbolLogEntry[],
  cap: number = SYMBOL_LOGS_RING_CAP,
): readonly SymbolLogEntry[] => {
  if (next.length === 0) return current;
  const seen = new Set(current.map(keyOf));
  const additions: SymbolLogEntry[] = [];
  for (const row of next) {
    const k = keyOf(row);
    if (seen.has(k)) continue;
    seen.add(k);
    additions.push(row);
  }
  if (additions.length === 0) return current;
  const merged = [...current, ...additions].sort(compareDesc);
  return merged.length > cap ? merged.slice(0, cap) : merged;
};

/**
 * Merge an older REST page into a newest-first array. Older rows can only
 * grow the tail; the cap still applies because a very long load-older
 * sequence would otherwise blow past the budget.
 */
export const mergeOlder = (
  current: readonly SymbolLogEntry[],
  older: readonly SymbolLogEntry[],
  cap: number = SYMBOL_LOGS_RING_CAP,
): readonly SymbolLogEntry[] => {
  const seen = new Set(current.map(keyOf));
  const additions: SymbolLogEntry[] = [];
  for (const row of older) {
    const k = keyOf(row);
    if (seen.has(k)) continue;
    seen.add(k);
    additions.push(row);
  }
  if (additions.length === 0) return current;
  const merged = [...current, ...additions].sort(compareDesc);
  return merged.length > cap ? merged.slice(0, cap) : merged;
};

interface SymbolLogsPanelProps {
  readonly profileId: string;
  readonly symbol: string;
  /**
   * The latest WS frame on the `logs` topic, surfaced from the route's
   * `useProfileSocket.onMessage`. Pass `null` while no frame has arrived.
   * The panel ignores frames whose `symbol` is neither `null`
   * (profile-scope) nor a match for the route's symbol.
   */
  readonly liveFrame: SymbolLogEntry | null;
  /** Test seam — defaults to Date.now. */
  readonly clock?: () => number;
}

/**
 * Virtualised log feed. Initial paint loads a 24h window, the WS topic
 * appends in real time, and "Load older" widens the window backwards. Row
 * height is fixed (compact mobile-first table) so the virtualiser stays
 * cheap without measuring.
 */
export function SymbolLogsPanel({
  profileId,
  symbol,
  liveFrame,
  clock = Date.now,
}: SymbolLogsPanelProps): React.JSX.Element {
  'use no memo';

  const initialRange = useMemo(() => {
    const to = new Date(clock());
    const from = new Date(to.getTime() - SYMBOL_LOGS_INITIAL_WINDOW_MS);
    return { from, to };
  }, [clock]);

  const initial = useQuery({
    queryKey: symbolLogsQueryKey(profileId, symbol),
    queryFn: () => fetchSymbolLogs(profileId, symbol, initialRange),
    staleTime: 30_000,
  });

  const [rows, setRows] = useState<readonly SymbolLogEntry[]>([]);
  // Idempotent: every time `initial.data` changes (first paint, refetch on
  // resync, refetch on stale-time elapse) fold the REST rows into the
  // existing ring buffer. `mergeAll` de-dupes by `(time, level, msg)` so
  // live frames already in `rows` aren't duplicated by their REST twins.
  useEffect(() => {
    if (!initial.data) return;
    setRows((prev) => mergeAll(prev, initial.data));
  }, [initial.data]);

  // WS append. Identity-checked against the previous frame so re-renders
  // that don't bring a new frame don't churn `rows`.
  const lastFrameKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!liveFrame) return;
    if (liveFrame.symbol !== null && liveFrame.symbol !== symbol) return;
    const k = keyOf(liveFrame);
    if (lastFrameKeyRef.current === k) return;
    lastFrameKeyRef.current = k;
    setRows((prev) => appendLive(prev, liveFrame));
  }, [liveFrame, symbol]);

  // "Load older" — widens `from` backwards by one page each click; we
  // remember the oldest `from` we've already covered so successive clicks
  // step further back instead of refetching the same window. Recovery of
  // any gap between live frames and the next paged window is the resync
  // path's job (see `onResyncRequired` in the route), not this button.
  const oldestFromRef = useRef<Date>(initialRange.from);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const onLoadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const to = oldestFromRef.current;
      const from = new Date(to.getTime() - SYMBOL_LOGS_PAGE_WINDOW_MS);
      const older = await fetchSymbolLogs(profileId, symbol, { from, to });
      oldestFromRef.current = from;
      setRows((prev) => mergeOlder(prev, older));
    } catch (err) {
      setOlderError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, profileId, symbol]);

  const parentRef = useRef<HTMLDivElement | null>(null);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual is not compiler-memoizable.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56,
    overscan: 6,
  });

  if (initial.isLoading) {
    // Sized to the loaded `h-72` virtualiser box rather than the shorter dashed
    // frame it replaces, so the scroller keeps its range across the swap.
    return (
      <section className="space-y-2" data-testid="symbol-logs-loading">
        <h2 className="text-sm font-semibold">Action logs</h2>
        <TableSkeleton rows={7} />
      </section>
    );
  }

  if (initial.error) {
    return (
      <Alert variant="danger">
        <AlertTitle>Logs unavailable</AlertTitle>
        <AlertDescription>
          {initial.error instanceof Error ? initial.error.message : 'unknown'}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <section className="space-y-2" data-testid="symbol-logs-panel">
      <header className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Action logs</h2>
        {rows.length > 0 ? (
          <span className="text-xs text-muted-fg" data-testid="symbol-logs-count">
            {rows.length} row{rows.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-fg" data-testid="symbol-logs-empty">
          No log entries in the last 24 hours.
        </p>
      ) : (
        <div
          ref={parentRef}
          data-testid="symbol-logs-scroll"
          className="h-72 overflow-y-auto rounded-md border border-border"
        >
          <ul
            className="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
            data-testid="symbol-logs-list"
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const row = rows[vi.index];
              if (!row) return null;
              return (
                <li
                  key={vi.key}
                  data-index={vi.index}
                  data-testid={`symbol-logs-row-${vi.index}`}
                  className="absolute top-0 left-0 w-full border-b border-border px-3 py-2 text-xs"
                  style={{
                    height: `${vi.size}px`,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-muted-fg">{row.time}</span>
                    <span className="font-medium">{row.level}</span>
                  </div>
                  <div className="truncate" title={row.msg}>
                    {row.msg}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void onLoadOlder()}
          disabled={loadingOlder || rows.length >= SYMBOL_LOGS_RING_CAP}
          data-testid="symbol-logs-load-older"
        >
          {loadingOlder ? 'Loading older…' : 'Load older'}
        </Button>
        {rows.length >= SYMBOL_LOGS_RING_CAP ? (
          <span className="text-xs text-muted-fg">cap {SYMBOL_LOGS_RING_CAP}</span>
        ) : null}
      </div>

      {olderError ? (
        <Alert variant="danger">
          <AlertTitle>Failed to load older</AlertTitle>
          <AlertDescription>{olderError}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
