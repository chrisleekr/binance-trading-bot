// History slice of the backtest workbench: the past-runs list with its outcome /
// type filters, cursor pagination, rows-per-page, multi-select for bulk delete,
// and the single confirm dialog that gates every irreversible deletion. The
// dedup dialog state also lives here (the launch mutation in the run slice sets
// it when an identical re-run is deduped).

import { useCallback, useMemo, useState, type SetStateAction } from 'react';
import { useMutation, useQuery, type QueryClient } from '@tanstack/react-query';

import { BACKTEST_LIST_DEFAULT_PAGE_SIZE, type BacktestParams } from '@app/contracts';
import { errorMessage } from '@/shared/lib/api';
import {
  backtestListQueryKey,
  deleteBacktest,
  fetchBacktestList,
} from '@/features/backtest/api/backtest';

/** Past-runs outcome filter; `all` omits the server-side filter param. */
export const RUNS_FILTERS = [
  ['all', 'All'],
  ['profit', 'Profit'],
  ['loss', 'Loss'],
  ['error', 'Error'],
] as const;
export type RunFilter = (typeof RUNS_FILTERS)[number][0];

/** Past-runs type filter; `all` omits the server-side `kind` param. */
export const RUNS_KIND_FILTERS = [
  ['all', 'All'],
  ['manual', 'Manual'],
] as const;
export type RunKind = (typeof RUNS_KIND_FILTERS)[number][0];

/** Rows-per-page choices for the Past-runs table (server-side `limit`). */
export const RUNS_PAGE_SIZES = [BACKTEST_LIST_DEFAULT_PAGE_SIZE, 25, 50, 100] as const;

// A pending deletion awaiting confirmation. One dialog serves both: a single
// run or a bulk selection.
export type PendingDelete = { kind: 'run'; runId: string } | { kind: 'bulk'; runIds: string[] };

/** Confirm-dialog copy for each deletion kind (null while the dialog is closed). */
export const deleteDialogCopy = (
  d: PendingDelete | null,
): { title: string; body: string; confirmLabel: string } => {
  switch (d?.kind) {
    case 'bulk':
      return {
        title: `Delete ${d.runIds.length} runs?`,
        body: `This permanently removes ${d.runIds.length} selected runs and their results from your history. It can’t be undone.`,
        confirmLabel: 'Delete runs',
      };
    default:
      return {
        title: 'Delete this backtest run?',
        body: `This permanently removes run ${d?.kind === 'run' ? d.runId.slice(0, 8) : ''} and its result from your history. It can’t be undone.`,
        confirmLabel: 'Delete run',
      };
  }
};

type Banner = { kind: 'ok' | 'err'; message: string } | null;

export interface BacktestHistoryArgs {
  profileId: string;
  activeRunId: string | null;
  showRun: (runId: string | null) => void;
  setBanner: (b: Banner) => void;
  baselineBacktestRunId: string | null;
  queryClient: QueryClient;
}

export function useBacktestHistory({
  profileId,
  activeRunId,
  showRun,
  setBanner,
  baselineBacktestRunId,
  queryClient,
}: BacktestHistoryArgs) {
  // Cursor pagination for past runs; new runs land at the head, so an offset
  // would re-show or skip rows. `history` is the stack of prior-page cursors so
  // Prev retraces the operator's path; the current page's cursor is `cursor`.
  type PageState = {
    cursor: string | null;
    history: readonly (string | null)[];
  };
  const [page, setPageState] = useState<PageState>({ cursor: null, history: [] });
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const setPage = useCallback((next: SetStateAction<PageState>): void => {
    setPageState(next);
    setSelectedRunIds(new Set());
  }, []);
  // Runs-table page size and status filter. Both are server-side: changing
  // either resets to the first page (cursors from the old query don't apply).
  const [rowsPerPage, setRowsPerPage] = useState<number>(BACKTEST_LIST_DEFAULT_PAGE_SIZE);
  const [runFilter, setRunFilter] = useState<RunFilter>('all');
  const [runKind, setRunKind] = useState<RunKind>('all');

  const runsFilterParam = runFilter === 'all' ? null : runFilter;
  const runsKindParam = runKind === 'all' ? null : runKind;
  // Omit `limit` at the default page size so the canonical first-page URL stays
  // param-free. Larger sizes send it.
  const runsLimitParam = rowsPerPage === BACKTEST_LIST_DEFAULT_PAGE_SIZE ? null : rowsPerPage;
  const runs = useQuery({
    queryKey: backtestListQueryKey(
      profileId,
      page.cursor,
      runsLimitParam,
      runsFilterParam,
      runsKindParam,
    ),
    queryFn: () =>
      fetchBacktestList(profileId, page.cursor, runsLimitParam, runsFilterParam, runsKindParam),
  });
  const runItems = runs.data?.items ?? [];
  const runsNextCursor = runs.data?.nextCursor ?? null;
  const runsTotal = runs.data?.total ?? 0;

  // One confirm dialog gates every (irreversible) deletion.
  const [confirmDelete, setConfirmDelete] = useState<PendingDelete | null>(null);

  // A blocking choice when a launch dedups onto an identical finished run.
  const [pendingDedup, setPendingDedup] = useState<{
    runId: string;
    params: BacktestParams;
  } | null>(null);

  // Every delete mutation closes the confirm dialog and surfaces the failure the
  // same way; only their success paths differ.
  const onDeleteError = (err: unknown): void => {
    setConfirmDelete(null);
    setBanner({ kind: 'err', message: errorMessage(err) });
  };

  const del = useMutation({
    mutationFn: (runId: string) => deleteBacktest(profileId, runId),
    onSuccess: (_void, runId) => {
      setConfirmDelete(null);
      setBanner({ kind: 'ok', message: `Run ${runId.slice(0, 8)} deleted.` });
      if (runId === activeRunId) showRun(null);
      setPage({ cursor: null, history: [] });
      void queryClient.invalidateQueries({ queryKey: ['backtest', 'list', profileId] });
    },
    onError: onDeleteError,
  });

  // Bulk delete is a fan-out of independent single-run deletes.
  const bulkDel = useMutation({
    mutationFn: async (runIds: string[]) => {
      const results = await Promise.allSettled(runIds.map((id) => deleteBacktest(profileId, id)));
      const deleted = runIds.filter((_id, i) => results[i]?.status === 'fulfilled');
      return { total: runIds.length, deleted };
    },
    onSuccess: ({ total, deleted }, _runIds) => {
      setConfirmDelete(null);
      if (activeRunId !== null && deleted.includes(activeRunId)) showRun(null);
      setPage({ cursor: null, history: [] });
      void queryClient.invalidateQueries({ queryKey: ['backtest', 'list', profileId] });
      const failed = total - deleted.length;
      setBanner(
        failed === 0
          ? { kind: 'ok', message: `Deleted ${total} run${total === 1 ? '' : 's'}.` }
          : {
              kind: 'err',
              message: `Deleted ${deleted.length} of ${total}; ${failed} could not be deleted.`,
            },
      );
    },
    onError: onDeleteError,
  });

  // A run is bulk-selectable/deletable only when the API would accept its delete.
  const isDeletable = useCallback(
    (r: { runId: string; status: string }): boolean =>
      r.status !== 'queued' && r.status !== 'running' && r.runId !== baselineBacktestRunId,
    [baselineBacktestRunId],
  );
  const deletableIds = useMemo(
    () => runItems.filter(isDeletable).map((r) => r.runId),
    [runItems, isDeletable],
  );
  const allSelected = deletableIds.length > 0 && deletableIds.every((id) => selectedRunIds.has(id));
  const someSelected = selectedRunIds.size > 0 && !allSelected;
  const deleteBusy = del.isPending || bulkDel.isPending;
  const deleteCopy = deleteDialogCopy(confirmDelete);

  return {
    runsQuery: runs,
    runItems,
    runsNextCursor,
    runsTotal,
    runFilter,
    setRunFilter,
    runKind,
    setRunKind,
    rowsPerPage,
    setRowsPerPage,
    page,
    setPage,
    selectedRunIds,
    setSelectedRunIds,
    deletableIds,
    allSelected,
    someSelected,
    isDeletable,
    confirmDelete,
    setConfirmDelete,
    deleteCopy,
    deleteBusy,
    del,
    bulkDel,
    pendingDedup,
    setPendingDedup,
    // Consumed by the run slice's launch optimistic write and page resets.
    runsFilterParam,
    runsKindParam,
    runsLimitParam,
  };
}
