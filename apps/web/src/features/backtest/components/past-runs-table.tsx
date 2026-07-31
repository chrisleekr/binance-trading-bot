// The past-runs list body: one responsive row per run. Rows stack into a card on
// mobile (< sm) and align into columns at sm+. The row itself is never
// clickable — an explicit "Load →" button loads a run into the workbench, so
// scrolling the list on a touch screen can't select a run by accident. The
// checkbox (bulk delete) and the ⋯ menu (abort / retry / delete) stay per row.

import { Ban, PinOff, RotateCcw, Trash2 } from 'lucide-react';

import { RowActions, type RowAction } from '@/shared/components/row-actions';
import { formatPercent } from '@/shared/lib/format';
import { formatDate } from '@/shared/lib/format-time';
import { useTimezone } from '@/shared/context/timezone-context';
import type { BacktestWorkbench } from './use-backtest-workbench';

export function PastRunsTable({ wb }: { wb: BacktestWorkbench }): React.JSX.Element {
  const timeZone = useTimezone();
  const { selectRun } = wb;
  const {
    runItems,
    selectedRunIds,
    setSelectedRunIds,
    deletableIds,
    allSelected,
    someSelected,
    isDeletable,
    setConfirmDelete,
  } = wb.history;
  const { activeRunId, abort, retry } = wb.run;
  const { unpinBaseline, baselineBacktestRunId } = wb.compare;

  return (
    <div>
      {/* Header: the select-all checkbox always renders (bulk-delete affordance);
          the column labels show only at sm+, where the rows read as a table. */}
      <div className="border-border text-muted-fg flex items-center gap-3 border-b px-3 py-2 text-xs">
        <input
          type="checkbox"
          className="accent-accent size-3.5 shrink-0 align-middle"
          aria-label="Select all deletable runs on this page"
          data-testid="backtest-select-all"
          disabled={deletableIds.length === 0}
          checked={allSelected}
          // `indeterminate` is a DOM property, not an attribute. The inline ref
          // closure re-runs on every commit, keeping it in sync with someSelected.
          ref={(el) => {
            if (el) el.indeterminate = someSelected;
          }}
          onChange={(e) => setSelectedRunIds(e.target.checked ? new Set(deletableIds) : new Set())}
        />
        <span className="hidden flex-1 sm:block">Symbol</span>
        <span className="hidden flex-1 sm:block">Window period</span>
        <span className="hidden w-20 sm:block">Status</span>
        <span className="hidden w-20 text-right sm:block">PnL</span>
        <span className="hidden w-28 sm:block" aria-hidden="true" />
      </div>

      <ul>
        {runItems.map((r) => {
          const inFlight = r.status === 'queued' || r.status === 'running';
          const aborting = abort.isPending && abort.variables === r.runId;
          const retrying = retry.isPending && retry.variables === r.runId;
          const selectable = isDeletable(r);
          const isBaseline = r.runId === baselineBacktestRunId;
          const rowActions: RowAction[] = [];
          if (inFlight) {
            rowActions.push({
              key: 'abort',
              testId: `backtest-abort-${r.runId}`,
              label: aborting ? 'Aborting…' : 'Abort',
              icon: <Ban className="h-4 w-4" aria-hidden="true" />,
              disabled: aborting,
              onSelect: () => abort.mutate(r.runId),
            });
          } else {
            if (r.status === 'error' || r.status === 'cancelled') {
              rowActions.push({
                key: 'retry',
                testId: `backtest-retry-${r.runId}`,
                label: retrying ? 'Retrying…' : 'Retry',
                icon: <RotateCcw className="h-4 w-4" aria-hidden="true" />,
                disabled: retrying,
                onSelect: () => retry.mutate(r.runId),
              });
            }
            if (isBaseline) {
              rowActions.push({
                key: 'unpin',
                testId: `backtest-unpin-baseline-${r.runId}`,
                label: unpinBaseline.isPending ? 'Unpinning…' : 'Unpin baseline',
                icon: <PinOff className="h-4 w-4" aria-hidden="true" />,
                disabled: unpinBaseline.isPending,
                onSelect: () => unpinBaseline.mutate(),
              });
            }
            rowActions.push({
              key: 'delete',
              testId: `backtest-delete-${r.runId}`,
              label: 'Delete',
              icon: <Trash2 className="h-4 w-4" aria-hidden="true" />,
              destructive: true,
              disabled: isBaseline,
              disabledReason: isBaseline ? 'Unpin the baseline first' : undefined,
              onSelect: () => setConfirmDelete({ kind: 'run', runId: r.runId }),
            });
          }

          return (
            <li
              key={r.runId}
              data-selected={r.runId === activeRunId}
              className="border-border data-[selected=true]:bg-surface-alt flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 last:border-b-0"
            >
              <div className="w-4 shrink-0">
                {selectable ? (
                  <input
                    type="checkbox"
                    className="accent-accent size-3.5 align-middle"
                    aria-label={`Select ${r.symbols.join(', ')} run`}
                    data-testid={`backtest-select-${r.runId}`}
                    checked={selectedRunIds.has(r.runId)}
                    onChange={(e) =>
                      setSelectedRunIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(r.runId);
                        else next.delete(r.runId);
                        return next;
                      })
                    }
                  />
                ) : null}
              </div>
              <div className="flex-1 basis-32 font-medium">{r.symbols.join(', ')}</div>
              <div className="text-muted-fg basis-full text-xs tabular-nums sm:flex-1 sm:basis-auto">
                {formatDate(r.fromMs, timeZone)} → {formatDate(r.toMs, timeZone)}
              </div>
              <div
                className={
                  'w-20 text-xs ' +
                  (r.status === 'done'
                    ? 'text-up'
                    : r.status === 'error'
                      ? 'text-down'
                      : 'text-muted-fg')
                }
              >
                {r.status}
              </div>
              <div
                className={
                  'w-20 text-right text-sm tabular-nums ' +
                  (r.totalReturnPct === null
                    ? 'text-muted-fg'
                    : r.totalReturnPct < 0
                      ? 'text-down'
                      : 'text-up')
                }
              >
                {r.totalReturnPct !== null ? formatPercent(r.totalReturnPct) : '—'}
              </div>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => selectRun(r.runId)}
                  aria-label={`Load ${r.symbols.join(', ')} run`}
                  aria-current={r.runId === activeRunId}
                  data-testid={`backtest-load-${r.runId}`}
                  className="text-accent focus-visible:ring-focus rounded-xs inline-flex items-center gap-1 px-2 py-1 text-sm font-medium hover:underline focus-visible:outline-none focus-visible:ring-2"
                >
                  Load →
                </button>
                <RowActions
                  label={`Actions for ${r.symbols.join(', ')} run`}
                  testId={`backtest-row-actions-${r.runId}`}
                  actions={rowActions}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
