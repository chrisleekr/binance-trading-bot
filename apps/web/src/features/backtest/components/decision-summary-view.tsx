import {
  attributeBlocker,
  type Blocker,
  type DecisionSummary,
  type ReasonAttributionMap,
} from '@/features/backtest/lib/decision-breakdown';

import type { ConfigShape } from './results-format';

/** Bar tint + short kind tag for a decision blocker. */
const BLOCKER_TINT: Record<Blocker['kind'], string> = {
  config: 'bg-accent',
  market: 'bg-muted-fg',
  sizing: 'bg-muted-fg',
  data: 'bg-border',
};
const BLOCKER_TAG: Record<Blocker['kind'], string> = {
  config: 'your setting',
  market: 'market',
  sizing: 'order size',
  data: 'warming up',
};

/** One-line "what to do about it" per blocker kind, shown on the dominant blocker. */
const KIND_GUIDANCE: Record<Blocker['kind'], string> = {
  config:
    'This is your setting. Relax or re-test it to measure whether it was helping or just blocking.',
  market:
    'The gate read the market correctly. Relaxing it would mean buying into a downtrend — not a tuning fix.',
  sizing:
    'The order was built but fell below a size floor. Raise the per-trade budget or lower the floor.',
  data: 'Indicators or ratings were still warming up. A longer test window resolves this on its own.',
};

/** One funnel stage: how many entries this gate blocked vs let through. */
function FunnelStage({
  label,
  blocked,
  passed,
}: {
  readonly label: string;
  readonly blocked: number;
  readonly passed: number;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-surface-alt p-2">
      <div className="text-[11px] text-muted-fg">{label}</div>
      <div className="font-mono text-sm text-fg tabular-nums">
        {blocked.toLocaleString()} <span className="text-[11px] text-muted-fg">blocked</span>
      </div>
      <div className="font-mono text-[11px] text-muted-fg tabular-nums">
        {passed.toLocaleString()} passed →
      </div>
    </div>
  );
}

/** The config-attribution line under a blocker: "set by `path` = value · detail". */
function BlockerAttributionLine({
  code,
  config,
  attribution,
  testId,
}: {
  readonly code: string;
  readonly config: ConfigShape;
  readonly attribution: ReasonAttributionMap;
  readonly testId?: string;
}): React.JSX.Element | null {
  const attr = attributeBlocker(code, attribution, config);
  if (attr === null) return null;
  return (
    <div className="text-[11px] text-muted-fg" data-testid={testId ?? `bt-why-attr-${code}`}>
      {attr.path ? (
        <>
          set by{' '}
          <code className="rounded bg-surface-alt px-1 py-0.5 font-mono text-fg">{attr.path}</code>
          {attr.value !== null && <> = {attr.value}</>}
        </>
      ) : (
        attr.setting
      )}
      {attr.detail && <> · {attr.detail}</>}
    </div>
  );
}

/**
 * Plain-language view of why entries did or didn't fire: a one-line headline when
 * a single gate dominates, the gate funnel, the dominant choke point, and a ranked
 * bar per blocking reason — each naming the exact config setting that armed it.
 * Replaces reading the raw `tt-*` counters by hand.
 */
export function DecisionSummaryView({
  summary,
  config,
  attribution,
}: {
  readonly summary: DecisionSummary;
  readonly config: ConfigShape;
  readonly attribution: ReasonAttributionMap;
}): React.JSX.Element {
  // When one gate accounts for almost everything, lead with a single sentence
  // naming it — a full-width "100%" bar conveys nothing on its own.
  const top = summary.blockers[0] ?? null;
  const dominant = top && top.pct >= 90 ? top : null;
  return (
    <div className="space-y-3" data-testid="bt-why-summary">
      <p className="text-sm text-fg">
        {summary.bought > 0
          ? `${summary.bought.toLocaleString()} of ${summary.eligible.toLocaleString()} entry decisions became trades. Here's where the rest stopped:`
          : `None of the ${summary.eligible.toLocaleString()} entry decisions became a trade. Here's where each stopped:`}
      </p>
      {dominant && (
        <div
          className="space-y-1 rounded-md border border-border bg-surface-alt p-2"
          data-testid="bt-why-dominant"
        >
          <p className="text-sm text-fg">
            Almost every entry —{' '}
            <span className="font-medium">
              {dominant.count.toLocaleString()} of {summary.eligible.toLocaleString()} (
              {dominant.pct}
              %)
            </span>{' '}
            — was stopped by one gate: {dominant.label}.
          </p>
          <BlockerAttributionLine
            code={dominant.code}
            config={config}
            attribution={attribution}
            testId="bt-why-dominant-attr"
          />
          <p className="text-xs text-muted-fg">{KIND_GUIDANCE[dominant.kind]}</p>
        </div>
      )}
      {/* The 3-stage funnel and the choke line assume the clean rating →
          indicator → sizing chain. Suppress them when out-of-funnel vetoes
          (regime / risk-cap / discovery) are present, since their numbers
          wouldn't reconcile; the ranked bars below still show every blocker. */}
      {summary.otherVetoed === 0 ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            <FunnelStage
              label="Technical-rating gate"
              blocked={summary.technicalsVetoed}
              passed={summary.technicalsPassed}
            />
            <FunnelStage
              label="Indicator gate"
              blocked={summary.indicatorVetoed}
              passed={summary.sizingSkipped + summary.bought}
            />
            <FunnelStage
              label="Order sizing"
              blocked={summary.sizingSkipped}
              passed={summary.bought}
            />
          </div>
          {summary.indicatorChoke ? (
            <p className="text-xs text-muted-fg" data-testid="bt-why-choke">
              Of the {summary.technicalsPassed.toLocaleString()} entries that passed the rating
              gate,{' '}
              <span className="font-medium text-fg">
                {summary.indicatorChoke.count.toLocaleString()} (
                {summary.indicatorChoke.pctOfPassed}%)
              </span>{' '}
              were then stopped by: {summary.indicatorChoke.label}. That gate is the binding
              constraint.
            </p>
          ) : null}
        </>
      ) : null}
      <ul className="space-y-2">
        {summary.blockers.map((b) => (
          <li key={b.code} className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-fg">
                {b.label} <span className="text-muted-fg">· {BLOCKER_TAG[b.kind]}</span>
              </span>
              <span className="shrink-0 font-mono text-muted-fg tabular-nums">
                {b.count.toLocaleString()} · {b.pct}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-alt">
              <div className={`h-full ${BLOCKER_TINT[b.kind]}`} style={{ width: `${b.pct}%` }} />
            </div>
            <BlockerAttributionLine code={b.code} config={config} attribution={attribution} />
          </li>
        ))}
      </ul>
    </div>
  );
}
