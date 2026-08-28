// The past-runs list body: one responsive row per run. Rows stack into a card on
// mobile (< sm) and align into columns at sm+. The row itself is never
// clickable — an explicit "Load →" button loads a run into the workbench, so
// scrolling the list on a touch screen can't select a run by accident. The
// checkbox (bulk delete) and the ⋯ menu (abort / retry / delete) stay per row.
//
// Picking two runs to compare their configs is a per-row BUTTON, not a second checkbox column. The checkbox already on the row means "include in the bulk delete", and a second one beside it would put two independent multi-select semantics on one row with nothing but a tooltip separating "queue this for deletion" from "compare this". The button arms one run, then reads as an invitation on every other row, so the two-step pick is visible in the rows themselves.

import { useState } from 'react';

import { Ban, GitCompare, PinOff, RotateCcw, Trash2 } from 'lucide-react';

import { RowActions, type RowAction } from '@/shared/components/row-actions';
import { formatPercent } from '@/shared/lib/format';
import { formatDate, formatInstant } from '@/shared/lib/format-time';
import { useTimezone } from '@/shared/context/timezone-context';
import type { BacktestWorkbench } from './use-backtest-workbench';
import { BacktestConfigCompareSheet, type CompareSide } from './backtest-config-compare-sheet';

export function PastRunsTable({ wb }: { wb: BacktestWorkbench }): React.JSX.Element {
  const timeZone = useTimezone();
  const { selectRun, profileId } = wb;
  // The two picked runs. `armed` is the first, held while the operator reads the other rows; `against` is the second, and setting it is what opens the drawer. Local because the pick is an affordance on this list and outlives nothing beyond it.
  const [armed, setArmed] = useState<CompareSide | null>(null);
  const [against, setAgainst] = useState<CompareSide | null>(null);
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
      <BacktestConfigCompareSheet
        profileId={profileId}
        a={armed}
        b={against}
        open={against !== null}
        // Closing drops BOTH picks. Leaving the first one armed would leave every other row still offering to compare against a run the operator has stopped thinking about, with nothing on screen saying which one it was.
        onOpenChange={(next) => {
          if (!next) {
            setArmed(null);
            setAgainst(null);
          }
        }}
      />
      {/* Header: the select-all checkbox always renders (bulk-delete affordance);
          the column labels show only at sm+, where the rows read as a table. */}
      <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-xs text-muted-fg">
        <input
          type="checkbox"
          className="size-3.5 shrink-0 align-middle accent-accent"
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
        {/* Two different times, and the operator needs both: the window is the market period the run replayed, "Run at" is when they launched it. Two runs of the same coin over the same window are otherwise indistinguishable. */}
        <span className="hidden flex-1 sm:block">Window period</span>
        <span className="hidden flex-1 sm:block">Run at</span>
        {/* Which SETTINGS the run executed. Two runs of one coin over one window differ only by config, and nothing else on the row can say so. */}
        <span className="hidden w-24 sm:block">Config</span>
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

          // Names every per-row control as well as the row itself: a screen reader hearing "Load BTCUSDT run" twice cannot pick between two runs of the same coin. The instant alone is not enough — it resolves only to the minute, and two runs launched in the same minute would collide again — so the id prefix that already identifies a run in the results header travels with it.
          const ranAt = formatInstant(r.createdAt, timeZone);
          const runLabel = `${r.symbols.join(', ')} run ${r.runId.slice(0, 8)} from ${ranAt}`;

          return (
            <li
              key={r.runId}
              data-selected={r.runId === activeRunId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2 last:border-b-0 data-[selected=true]:bg-surface-alt"
            >
              <div className="w-4 shrink-0">
                {selectable ? (
                  <input
                    type="checkbox"
                    className="size-3.5 align-middle accent-accent"
                    aria-label={`Select ${runLabel}`}
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
              {/* Below sm the column headers are hidden and both cells go full-width, so the row shows two stacked dates with nothing saying which is the replayed market window and which is the launch time. The label rides inside the cell at that width and goes `sr-only` once the header row is back — not `hidden`, because `display: none` drops it from the accessibility tree, which would leave a screen reader on a wide viewport hearing the same two bare dates the sighted mobile reader was rescued from. */}
              <div className="basis-full text-xs text-muted-fg tabular-nums sm:flex-1 sm:basis-auto">
                <span className="sm:sr-only">Window </span>
                {formatDate(r.fromMs, timeZone)} → {formatDate(r.toMs, timeZone)}
              </div>
              <div className="basis-full text-xs text-muted-fg tabular-nums sm:flex-1 sm:basis-auto">
                <span className="sm:sr-only">Run at </span>
                {ranAt}
              </div>
              {/* The fingerprint hashes the merged strategy config alone, so an equal code means the two runs differed by window, not by settings. Shown as an 8-character prefix — the repo's short-id width — with the whole digest on `title`, because eight hex characters can collide and a reader comparing two rows needs the full value to settle it. Stacks full-width below sm behind the same in-cell `sm:sr-only` label the two date cells use, so it is never a bare hash. */}
              <div
                className="basis-full text-xs text-muted-fg tabular-nums sm:w-24 sm:basis-auto"
                data-testid={`backtest-config-${r.runId}`}
              >
                <span className="sm:sr-only">Config </span>
                {r.configFingerprint !== null ? (
                  <span className="font-mono" title={r.configFingerprint}>
                    {r.configFingerprint.slice(0, 8)}
                  </span>
                ) : (
                  '—'
                )}
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
                {/* Offered on every row including one with no fingerprint. Hiding it there would make the drawer's "config unavailable" answer unreachable from the list, leaving an operator to read a blank Config cell as a rendering fault rather than as a run that predates the stamping. */}
                <button
                  type="button"
                  onClick={() => {
                    const side: CompareSide = {
                      runId: r.runId,
                      label: r.symbols.join(', ') + ' · ' + ranAt,
                      configFingerprint: r.configFingerprint,
                    };
                    if (armed === null) setArmed(side);
                    else if (armed.runId === r.runId) setArmed(null);
                    else setAgainst(side);
                  }}
                  aria-pressed={armed?.runId === r.runId}
                  aria-label={
                    armed === null
                      ? `Compare config of ${runLabel}`
                      : armed.runId === r.runId
                        ? `Cancel comparing ${runLabel}`
                        : `Compare config of ${runLabel} against the armed run`
                  }
                  title={
                    armed === null || armed.runId === r.runId
                      ? 'Compare config'
                      : 'Compare against the armed run'
                  }
                  data-testid={`backtest-compare-config-${r.runId}`}
                  className="inline-flex items-center rounded-xs p-1 text-muted-fg hover:text-fg focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none aria-pressed:text-accent"
                >
                  <GitCompare className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => selectRun(r.runId)}
                  aria-label={`Load ${runLabel}`}
                  aria-current={r.runId === activeRunId ? 'page' : undefined}
                  data-testid={`backtest-load-${r.runId}`}
                  className="inline-flex items-center gap-1 rounded-xs px-2 py-1 text-sm font-medium text-accent hover:underline focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
                >
                  Load →
                </button>
                <RowActions
                  label={`Actions for ${runLabel}`}
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
