// The History tab: the past-runs list with its outcome / type filters, rows-per-
// page control, bulk-delete bar, and the paginated footer showing the total run
// count and the current page over cursor-based paging.

import { Button } from '@/shared/components/ui/button';
import { PastRunsTable } from './past-runs-table';
import {
  RUNS_FILTERS,
  RUNS_KIND_FILTERS,
  RUNS_PAGE_SIZES,
  type BacktestWorkbench,
} from './use-backtest-workbench';

export function HistoryTab({ wb }: { wb: BacktestWorkbench }): React.JSX.Element {
  const {
    runsQuery,
    runItems,
    runFilter,
    setRunFilter,
    runKind,
    setRunKind,
    rowsPerPage,
    setRowsPerPage,
    page,
    setPage,
    runsNextCursor,
    runsTotal,
    selectedRunIds,
    bulkDel,
    setConfirmDelete,
  } = wb.history;

  const totalPages = runsTotal === 0 ? 0 : Math.ceil(runsTotal / rowsPerPage);

  return (
    <section aria-labelledby="bt-runs-h" className="rounded-md border border-border bg-bg-elevated">
      <h2 id="bt-runs-h" className="border-b border-border px-3 py-2 text-sm font-semibold text-fg">
        Past runs
      </h2>
      {runsQuery.data && (runItems.length > 0 || runFilter !== 'all' || runKind !== 'all') ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-3">
            <div
              className="flex items-center gap-1"
              role="group"
              aria-label="Filter runs by outcome"
            >
              {RUNS_FILTERS.map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={runFilter === key ? 'default' : 'outline'}
                  onClick={() => {
                    setRunFilter(key);
                    setPage({ cursor: null, history: [] });
                  }}
                  data-testid={`bt-runs-filter-${key}`}
                >
                  {label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1" role="group" aria-label="Filter runs by type">
              {RUNS_KIND_FILTERS.map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  size="sm"
                  variant={runKind === key ? 'default' : 'outline'}
                  onClick={() => {
                    setRunKind(key);
                    setPage({ cursor: null, history: [] });
                  }}
                  data-testid={`bt-runs-kind-${key}`}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-fg">
            Rows per page
            <select
              value={rowsPerPage}
              onChange={(e) => {
                setRowsPerPage(Number(e.target.value));
                setPage({ cursor: null, history: [] });
              }}
              className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-xs text-fg"
              data-testid="bt-runs-page-size"
            >
              {RUNS_PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {selectedRunIds.size > 0 ? (
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-sm text-muted-fg">{selectedRunIds.size} selected</span>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            data-testid="backtest-delete-selected"
            disabled={bulkDel.isPending}
            onClick={() => setConfirmDelete({ kind: 'bulk', runIds: [...selectedRunIds] })}
          >
            {bulkDel.isPending ? 'Deleting…' : `Delete selected (${selectedRunIds.size})`}
          </Button>
        </div>
      ) : null}
      {runsQuery.data && runItems.length === 0 ? (
        <p className="p-3 text-sm text-muted-fg">
          {runFilter === 'all' && runKind === 'all' ? 'No runs yet.' : 'No runs match this filter.'}
        </p>
      ) : (
        <PastRunsTable wb={wb} />
      )}
      {runItems.length > 0 ? (
        <div className="flex items-center justify-between border-t border-border px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={() =>
              setPage((p) => ({
                cursor: p.history.at(-1) ?? null,
                history: p.history.slice(0, -1),
              }))
            }
            disabled={page.history.length === 0}
          >
            ‹ Prev
          </Button>
          <span
            className="font-mono text-xs text-muted-fg tabular-nums"
            data-testid="bt-runs-pagination"
          >
            {runsTotal === 0
              ? '0 runs'
              : `${runsTotal} runs · page ${page.history.length + 1} of ${totalPages}`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="default"
            onClick={() => {
              if (runsNextCursor)
                setPage((p) => ({
                  cursor: runsNextCursor,
                  history: [...p.history, p.cursor],
                }));
            }}
            disabled={runsNextCursor === null}
          >
            Next ›
          </Button>
        </div>
      ) : null}
    </section>
  );
}
