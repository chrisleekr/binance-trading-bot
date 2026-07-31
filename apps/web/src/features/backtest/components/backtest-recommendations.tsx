import { useState } from 'react';
import { Check } from 'lucide-react';

import type { BacktestResult } from '@app/contracts';

import { Button } from '@/shared/components/ui/button';
import {
  applyRecommendations,
  recommendConfigChanges,
} from '@/features/backtest/lib/decision-breakdown';

export interface BacktestRecommendationsProps {
  readonly breakdown: BacktestResult['decisionBreakdown'];
  /** The config that produced this run, used to compute the relaxed variants. */
  readonly config: Record<string, unknown>;
  /**
   * Load the composed config (base + the selected changes) into the Setup form.
   * The caller seeds the form and switches tabs; this never writes the live
   * config and never runs a backtest — the operator runs it when ready.
   */
  readonly onApply: (nextConfig: Record<string, unknown>) => void;
}

/**
 * Guarded entry-gate suggestions for a run that blocked (nearly) every entry.
 * The operator selects any combination, then loads them together into the Setup
 * form for a re-run they trigger themselves. Selecting changes nothing live and
 * runs nothing; the out-of-sample gate still stands between a tested config and
 * going live. Renders nothing when no armed constraint is biting.
 */
export function BacktestRecommendations({
  breakdown,
  config,
  onApply,
}: BacktestRecommendationsProps): React.JSX.Element | null {
  const recs = recommendConfigChanges(breakdown, config);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  if (recs.length === 0) return null;

  const toggle = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chosen = recs.filter((r) => selected.has(r.id));
  const loadSelected = (): void => onApply(applyRecommendations(config, chosen));

  return (
    <section
      aria-labelledby="bt-recs-h"
      data-testid="backtest-recommendations"
      className="border-border bg-bg-elevated space-y-3 rounded-md border p-3"
    >
      <div className="space-y-1">
        <h2 id="bt-recs-h" className="text-fg text-sm font-semibold">
          Suggested changes to test
        </h2>
        <p className="text-muted-fg text-xs">
          Pick the changes you want to try, then load them into the Setup form together. Nothing
          touches your live config and nothing runs until you click Run backtest. Each removes a
          constraint so you can measure its effect; they are not predictions of profit.
        </p>
      </div>
      <ul className="space-y-2">
        {recs.map((r) => {
          const isSelected = selected.has(r.id);
          return (
            <li key={r.id}>
              <button
                type="button"
                aria-pressed={isSelected}
                aria-label={r.title}
                onClick={() => toggle(r.id)}
                data-testid={`backtest-rec-toggle-${r.id}`}
                className={`focus-visible:ring-focus flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 ${
                  isSelected ? 'border-accent bg-accent/10' : 'border-border bg-surface-alt'
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    isSelected ? 'border-accent bg-accent text-accent-fg' : 'border-border'
                  }`}
                >
                  {isSelected ? <Check className="h-3 w-3" /> : null}
                </span>
                <span className="space-y-1">
                  <span className="text-fg block text-sm font-medium">{r.title}</span>
                  <span className="text-muted-fg block text-xs leading-snug">{r.rationale}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="border-border space-y-1.5 border-t pt-3">
        <Button
          type="button"
          variant="primary"
          className="h-11 w-full"
          disabled={chosen.length === 0}
          onClick={loadSelected}
          data-testid="backtest-rec-load-selected"
        >
          {chosen.length === 0
            ? 'Select changes to load'
            : `Load ${chosen.length} change${chosen.length > 1 ? 's' : ''} into Setup`}
        </Button>
        <p className="text-muted-fg text-xs">
          Loads into the Setup form for review. You run the backtest, and the new run must clear the
          out-of-sample gate before you can apply it to live.
        </p>
      </div>
    </section>
  );
}
