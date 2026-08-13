import { sameMarket, type BacktestResult } from '@app/contracts';

import { useMemo, useState } from 'react';

import { formatPercent } from '@/shared/lib/format';
import { tone, toneClass } from './results-format';

/**
 * A finished run offered as a comparison anchor in the Verdict header: the run
 * the viewed run forked from (Parent) or the profile's pinned live Baseline. The
 * route resolves these (they are separate run-detail fetches) and passes only
 * done runs that carry a result, so the header can read params + metrics directly.
 */
export interface BacktestComparisonAnchor {
  readonly runId: string;
  readonly result: BacktestResult;
}

interface ComparisonAnchorOption {
  readonly key: 'parent' | 'baseline';
  readonly label: string;
  readonly anchor: BacktestComparisonAnchor;
}

/**
 * Verdict-header comparison strip. Offers Parent and/or Baseline anchors (only
 * those that exist), defaulting to Parent and falling back to Baseline. When the
 * viewed run and the selected anchor ran the same market window, it shows signed
 * deltas for return, alpha, and drawdown; otherwise it says they are not
 * comparable and shows no deltas. drawdown is signed (<= 0), so a less-negative
 * delta is an improvement, the same higher-is-better sign as return and alpha,
 * which is why the shared tone helper colors a positive delta green for all three.
 */
export function ComparisonHeader({
  viewed,
  parentAnchor,
  baselineAnchor,
}: {
  readonly viewed: BacktestResult;
  readonly parentAnchor: BacktestComparisonAnchor | null;
  readonly baselineAnchor: BacktestComparisonAnchor | null;
}): React.JSX.Element | null {
  const options = useMemo<ComparisonAnchorOption[]>(() => {
    const list: ComparisonAnchorOption[] = [];
    if (parentAnchor) list.push({ key: 'parent', label: 'Parent', anchor: parentAnchor });
    if (baselineAnchor) list.push({ key: 'baseline', label: 'Baseline', anchor: baselineAnchor });
    return list;
  }, [parentAnchor, baselineAnchor]);

  const [selected, setSelected] = useState<'parent' | 'baseline'>('parent');

  // Clamp to an available option so a stale selection (no parent on this run)
  // resolves to the first offered anchor; with no anchors at all, render nothing.
  const active = options.find((o) => o.key === selected) ?? options[0];
  if (!active) return null;
  const anchorResult = active.anchor.result;
  const comparable = sameMarket(viewed.params, anchorResult.params);
  const deltas = comparable
    ? [
        {
          label: 'Return Δ',
          value: viewed.metrics.totalReturnPct - anchorResult.metrics.totalReturnPct,
        },
        {
          label: 'Alpha Δ',
          value: viewed.metrics.alphaVsHoldPct - anchorResult.metrics.alphaVsHoldPct,
        },
        {
          label: 'Drawdown Δ',
          value: viewed.metrics.maxDrawdownPct - anchorResult.metrics.maxDrawdownPct,
        },
      ]
    : [];

  return (
    <section
      aria-label="Compare against another run"
      data-testid="backtest-compare"
      className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-fg">Compare vs</span>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => setSelected(o.key)}
            aria-pressed={active.key === o.key}
            data-testid={`backtest-compare-${o.key}`}
            className={`rounded-md border px-2 py-1 text-xs ${
              active.key === o.key ? 'border-accent text-accent' : 'border-border text-muted-fg'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
      {comparable ? (
        <div data-testid="backtest-compare-deltas" className="grid grid-cols-3 gap-px bg-border">
          {deltas.map((d) => (
            <div key={d.label} className="bg-bg-elevated p-2">
              <div className="text-[11px] text-muted-fg">{d.label}</div>
              <div className={`font-mono text-sm tabular-nums ${toneClass(tone(d.value))}`}>
                {formatPercent(d.value, { sign: true })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-fg" data-testid="backtest-compare-incomparable">
          Not comparable — different market window.
        </p>
      )}
    </section>
  );
}
