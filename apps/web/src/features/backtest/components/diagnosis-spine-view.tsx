import type { DiagnosisItem } from '@/features/backtest/lib/diagnosis-spine';

/** Short kind tag for a diagnosis-spine item, so the operator reads what kind of cause it is. */
const DIAGNOSIS_TAG: Record<DiagnosisItem['kind'], string> = {
  blocker: 'entry blocker',
  'gate-fail': 'live gate',
  segment: 'segment read',
  none: 'no cause',
};

/**
 * The deterministic diagnosis spine: the ranked, provable causes for this run's
 * outcome, read first — above the metrics and the evidence. Each item is a fact
 * the run's data states (a counted blocker with its config lever, a missed gate
 * threshold, a segment read). The "no deterministic cause" item links down to
 * the existing "What next?" section rather than inventing a heuristic reason.
 */
export function DiagnosisSpine({
  items,
  hasNextSteps,
}: {
  readonly items: readonly DiagnosisItem[];
  /** Whether the "What next?" section (id `bt-next-h`) renders, so the no-cause
   *  item only links to it when the anchor actually exists. */
  readonly hasNextSteps: boolean;
}): React.JSX.Element {
  return (
    <section
      aria-labelledby="bt-diagnosis-h"
      data-testid="bt-diagnosis-spine"
      className="space-y-2 rounded-md border border-border bg-bg-elevated p-3"
    >
      <h2 id="bt-diagnosis-h" className="text-sm font-semibold text-fg">
        What the run proves
      </h2>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="space-y-0.5 text-sm">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-fg">
                {item.title}{' '}
                <span className="text-xs text-muted-fg">· {DIAGNOSIS_TAG[item.kind]}</span>
              </span>
              {item.count !== undefined ? (
                <span className="shrink-0 font-mono text-xs text-muted-fg tabular-nums">
                  {item.count.toLocaleString()}
                </span>
              ) : null}
            </div>
            {item.lever?.path ? (
              <div className="text-[11px] text-muted-fg">
                set by{' '}
                <code className="rounded bg-surface-alt px-1 py-0.5 font-mono text-fg">
                  {item.lever.path}
                </code>
                {item.lever.value !== null && <> = {item.lever.value}</>}
                {item.lever.detail && <> · {item.lever.detail}</>}
              </div>
            ) : null}
            {item.detail && !item.lever?.path ? (
              <div className="text-[11px] text-muted-fg">
                {item.detail}
                {item.kind === 'none' && hasNextSteps ? (
                  <>
                    {' '}
                    <a href="#bt-next-h" className="text-accent underline">
                      Go to What next?
                    </a>
                  </>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
