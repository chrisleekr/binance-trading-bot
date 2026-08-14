// The body of an investigation: confirm it, watch it, read it.
//
// Every step's state comes from the worker's own writes, polled. There is no
// client-side timer advancing anything — a tool whose whole value is honest
// measurement must not animate progress it has not observed. A fast step
// flashes; that is truthful.

import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleDashed,
  HelpCircle,
  Loader2,
  Minus,
} from 'lucide-react';
import type {
  DiagnosisItem,
  DiagnosisLever,
  DiagnosisRun,
  DiagnosisStep,
  DiagnosisStepStatus,
  DiagnosisVerdict,
} from '@app/contracts';

import { ConditionTimeline } from '@/features/profile/components/condition-timeline';
import { Button } from '@/shared/components/ui/button';
import { useActiveAccountId } from '@/shared/lib/account-scope';
import { cn } from '@/shared/lib/cn';
import { humaniseAge } from '@/shared/lib/format-time';

/** Which settings page owns each lever surface. Literals, so the typed Link accepts them. */
const SURFACE_ROUTE = {
  discovery: '/accounts/$accountId/profiles/$profileId/discovery',
  config: '/accounts/$accountId/profiles/$profileId/config',
  risk: '/accounts/$accountId/profiles/$profileId/risk',
} as const;

const STEP_ICON: Record<DiagnosisStepStatus, { icon: typeof Check; className: string }> = {
  pending: { icon: CircleDashed, className: 'text-muted-fg' },
  running: { icon: Loader2, className: 'text-accent animate-spin' },
  ok: { icon: Check, className: 'text-success' },
  finding: { icon: AlertTriangle, className: 'text-warning' },
  skipped: { icon: Minus, className: 'text-muted-fg' },
  unknown: { icon: HelpCircle, className: 'text-muted-fg' },
};

const VERDICT_COPY: Record<DiagnosisVerdict, { label: string; className: string }> = {
  trading: { label: 'Nothing is in the way', className: 'text-success' },
  blocked: { label: 'Something is blocking it', className: 'text-danger' },
  'idle-by-design': { label: 'Idle on purpose', className: 'text-warning' },
  unknown: { label: 'Not enough information', className: 'text-muted-fg' },
};

function StepRow({ step }: { readonly step: DiagnosisStep }): React.JSX.Element {
  const { icon: Icon, className } = STEP_ICON[step.status];
  return (
    <li
      className="flex gap-2 py-1.5"
      data-testid={`diagnosis-step-${step.id}`}
      data-status={step.status}
    >
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', className)} aria-hidden />
      <div className="min-w-0">
        <p className={cn('text-sm', step.status === 'pending' && 'text-muted-fg')}>{step.label}</p>
        {step.line ? <p className="text-xs text-muted-fg">{step.line}</p> : null}
      </div>
    </li>
  );
}

function LeverLink({
  lever,
  profileId,
}: {
  readonly lever: DiagnosisLever;
  readonly profileId: string;
}): React.JSX.Element {
  const accountId = useActiveAccountId() ?? '';
  return (
    <Link
      to={SURFACE_ROUTE[lever.surface]}
      params={{ accountId, profileId }}
      search={{ focus: lever.path }}
      className="inline-flex min-h-11 items-center gap-1 text-sm text-accent"
      data-testid={`diagnosis-lever-${lever.path}`}
    >
      Fix this: {lever.label}
      {lever.value === null ? null : <span className="text-muted-fg">({lever.value})</span>}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden />
    </Link>
  );
}

function ItemCard({
  item,
  asOfMs,
  profileId,
}: {
  readonly item: DiagnosisItem;
  readonly asOfMs: number;
  readonly profileId: string;
}): React.JSX.Element {
  // Measured against the report's own timestamp, not the wall clock: the report
  // is a frozen observation, and a duration that keeps counting after the run
  // finished would claim a freshness the run does not have.
  const held = item.sinceMs === null ? null : humaniseAge(asOfMs - item.sinceMs);
  return (
    <li
      className="rounded-md border border-border p-3"
      data-testid={`diagnosis-item-${item.id}`}
      data-severity={item.severity}
    >
      <div className="flex items-start justify-between gap-2">
        <p className={cn('text-sm font-medium', item.severity === 'blocking' && 'text-danger')}>
          {item.title}
        </p>
        {held ? (
          <span className="shrink-0 text-xs text-muted-fg" data-testid="diagnosis-item-since">
            for {held}
          </span>
        ) : null}
      </div>
      {item.detail ? <p className="mt-1 text-xs text-muted-fg">{item.detail}</p> : null}
      <ul className="mt-2 space-y-0.5 text-xs text-muted-fg">
        {item.evidence.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
      {item.symbols.length > 0 ? (
        <p className="mt-2 text-xs text-muted-fg">{item.symbols.map((s) => s.symbol).join(', ')}</p>
      ) : null}
      {item.lever ? <LeverLink lever={item.lever} profileId={profileId} /> : null}
    </li>
  );
}

/** The pre-run screen. States the cost and that nothing will change. */
export function DiagnosisConfirm({
  onConfirm,
  isStarting,
}: {
  readonly onConfirm: (liveProbe: boolean) => void;
  readonly isStarting: boolean;
}): React.JSX.Element {
  return (
    <div className="space-y-4" data-testid="diagnosis-confirm">
      <p className="text-sm">
        This walks a checklist — is the engine up, is the profile on, are the settings valid, is
        discovery scanning, where do candidate coins drop out, what is holding back buys, and what
        the coins you already hold are waiting on before they sell.
      </p>
      <p className="text-sm text-muted-fg">
        It is read-only. Nothing is paused, bought, sold, or changed. The coin-scan check re-runs
        that scan against Binance for an independent second opinion, which takes a few seconds and
        uses a little of this account&rsquo;s request budget.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={() => onConfirm(true)} disabled={isStarting} data-testid="diagnosis-start">
          Investigate
        </Button>
        <Button
          variant="outline"
          onClick={() => onConfirm(false)}
          disabled={isStarting}
          data-testid="diagnosis-start-stored"
        >
          Skip the live re-scan
        </Button>
      </div>
    </div>
  );
}

/** The live ladder plus, once it finishes, the ranked answer. */
export function DiagnosisRunBody({
  run,
  profileId,
}: {
  readonly run: DiagnosisRun;
  readonly profileId: string;
}): React.JSX.Element {
  const report = run.report;
  const verdict = report ? VERDICT_COPY[report.verdict] : null;
  // `data-run-id` is what lets a test tell "the same run, resumed" from "a
  // second run, started" — the two look identical without it.
  return (
    <div
      className="space-y-4"
      data-testid="diagnosis-run"
      data-run-id={run.id}
      data-run-status={run.status}
    >
      {run.status === 'error' ? (
        <p className="text-sm text-danger" data-testid="diagnosis-error">
          {run.error ?? 'The investigation could not be completed.'}
        </p>
      ) : null}

      {report && verdict ? (
        <div data-testid="diagnosis-verdict" data-verdict={report.verdict}>
          <p className={cn('text-xs font-semibold tracking-wide uppercase', verdict.className)}>
            {verdict.label}
          </p>
          <p className="mt-1 text-sm font-medium">{report.headline}</p>
        </div>
      ) : null}

      <ul className="divide-y divide-border">
        {run.steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </ul>

      {report && report.items.length > 0 ? (
        <ul className="space-y-2" data-testid="diagnosis-items">
          {report.items.map((item) => (
            <ItemCard key={item.id} item={item} asOfMs={report.asOfMs} profileId={profileId} />
          ))}
        </ul>
      ) : null}

      {report ? <ConditionTimeline report={report} /> : null}
    </div>
  );
}
