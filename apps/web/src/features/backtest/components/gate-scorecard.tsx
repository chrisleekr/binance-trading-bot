// Live-gate quality scorecard, shown on a finished backtest. Answers "do THESE
// results clear the gate's quality bar?" — the per-criterion profit-factor /
// trade-count / alpha check the live-enablement gate enforces — so the operator
// sees it at backtest time instead of discovering it as a 409 when they try to
// enable. It reuses the gate's own `gateThresholdChecks`, so the criteria here
// and the gate can never drift.
//
// Scope: this is the THRESHOLD bar only. Actually going live also needs the
// SAVED config to match a recent backtest (freshness + fingerprint) — that's the
// gate-status card's job. So the summary says "would clear the quality bar", not
// "you can enable now".

import { Check, X } from 'lucide-react';

import { Card } from '@/shared/components/ui/card';
import { InfoHint } from '@/shared/components/ui/info-hint';
import { cn } from '@/shared/lib/cn';
import { gateCandidate } from '@/features/backtest/lib/gate-candidate';

import {
  gateThresholdChecks,
  type BacktestMetrics,
  type EnablementPolicy,
  type OutOfSampleSegment,
} from '@app/contracts';

export function GateScorecard({
  metrics,
  outOfSample,
  dataWarnings,
  policy,
}: {
  readonly metrics: BacktestMetrics;
  readonly outOfSample: OutOfSampleSegment | null;
  readonly dataWarnings: readonly string[];
  readonly policy: EnablementPolicy;
}): React.JSX.Element {
  const checks = gateThresholdChecks(gateCandidate(metrics, outOfSample, dataWarnings), policy);
  const passed = checks.every((c) => c.ok);
  const failedCount = checks.filter((c) => !c.ok).length;

  return (
    <Card className="space-y-3 p-4" data-testid="gate-scorecard">
      <header className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-1">
          <h3 className="text-fg text-sm font-semibold">Live-gate quality check</h3>
          <InfoHint label="Live-gate quality check">
            A sanity check that this config actually made money in the backtest before you risk real
            money. Advisory only — it never blocks you.
          </InfoHint>
        </span>
        <span
          data-testid="gate-scorecard-verdict"
          className={cn(
            'text-xs font-semibold uppercase tracking-wider',
            passed ? 'text-success' : 'text-warning',
          )}
        >
          {passed ? 'Clears the bar' : `${failedCount} below threshold`}
        </span>
      </header>

      <ul className="space-y-1.5">
        {checks.map((c) => (
          <li
            key={c.label}
            className="flex items-center justify-between gap-3 text-sm"
            data-testid={`gate-check-${c.label.replace(/\s+/g, '-')}`}
          >
            <span className="flex items-center gap-2">
              {c.ok ? (
                <Check className="text-success h-4 w-4" aria-hidden />
              ) : (
                <X className="text-warning h-4 w-4" aria-hidden />
              )}
              <span className="text-fg capitalize">{c.label}</span>
            </span>
            <span className="text-muted-fg font-mono text-xs">
              {c.actual} <span className="opacity-60">(need {c.need})</span>
            </span>
          </li>
        ))}
      </ul>

      <p className="text-muted-fg text-xs">
        {passed
          ? 'These results clear the gate’s quality thresholds — a green light that this config is proven. Enabling live is never blocked by the gate; this is advisory.'
          : 'These results do not clear the gate’s quality thresholds. Enabling live is never blocked, but if you turn on “pause new buys when unproven” for this profile, a live config that stops passing has its new buys paused until a run clears the gate (open positions still sell). Tune the config and re-run.'}
        {policy.enabled ? null : ' The live gate is currently turned off for this profile.'}
      </p>
    </Card>
  );
}
