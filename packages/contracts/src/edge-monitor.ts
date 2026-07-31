import Decimal from 'decimal.js';
import { z } from 'zod';

/**
 * Per-profile policy for the live edge-decay monitor. The enablement gate proves
 * an edge once, at enable-time; this keeps watching a LIVE profile and reacts
 * when its realized net profit factor falls below the proven backtest baseline.
 *
 * `mode` is the only behavioural switch: `off` disables the monitor, `warn`
 * surfaces a decayed verdict and sends a heads-up notification without touching
 * trading (the bot never pauses buys for edge decay). `warnFactor`/`breachFactor`
 * are fractions of the baseline profit factor: live PF below `baseline *
 * warnFactor` is a warning, below `baseline * breachFactor` is a breach.
 * `minTrades` is the sample floor so a handful of live trades cannot trip the
 * monitor.
 */
export const EdgeMonitorPolicy = z
  .object({
    mode: z.enum(['off', 'warn']).default('warn'),
    minTrades: z.number().int().positive().default(10),
    warnFactor: z.number().positive().max(1).default(0.85),
    breachFactor: z.number().positive().max(1).default(0.6),
  })
  .refine((p) => p.breachFactor <= p.warnFactor, {
    message: 'breachFactor must be <= warnFactor',
    path: ['breachFactor'],
  });
export type EdgeMonitorPolicy = z.infer<typeof EdgeMonitorPolicy>;
/** The effective monitor policy when a profile has not customised one. */
export const DEFAULT_EDGE_MONITOR_POLICY: EdgeMonitorPolicy = EdgeMonitorPolicy.parse({});

/**
 * Verdict of one edge-decay evaluation. `monitor-off`/`no-baseline`/
 * `insufficient-data` are non-judgements (the monitor cannot or should not act);
 * `healthy`/`warning`/`breached` are the live-vs-baseline comparison. All are
 * advisory — they drive the dashboard badge and, on `breached`, a heads-up
 * notification; none pauses entries.
 */
export const EdgeDecayVerdict = z.enum([
  'monitor-off',
  'no-baseline',
  'insufficient-data',
  'healthy',
  'warning',
  'breached',
]);
export type EdgeDecayVerdict = z.infer<typeof EdgeDecayVerdict>;

/**
 * Profit factor (gross win / gross loss) from a closed-trade summary's gross
 * sums. `null` when there are no losses (an infinite PF), so callers treat it as
 * "no decay signal" rather than dividing by zero. Both inputs are decimal
 * strings; the ratio is a dimensionless comparison number, not stored money.
 */
export function profitFactorFromGross(grossProfit: string, grossLoss: string): number | null {
  const gl = new Decimal(grossLoss);
  if (gl.lte(0)) return null;
  return new Decimal(grossProfit).div(gl).toNumber();
}

/** Inputs to {@link assessEdgeDecay}: the policy, the proven baseline PF, and the live PF + sample. */
export interface EdgeDecayInput {
  readonly policy: EdgeMonitorPolicy;
  /** True when a baseline backtest is pinned and readable. */
  readonly hasBaseline: boolean;
  /** Baseline (backtest) net profit factor; `null` = baseline had no losses (PF ∞). */
  readonly baselineProfitFactor: number | null;
  /** Live realized net profit factor over the window; `null` = no live losses yet. */
  readonly liveProfitFactor: number | null;
  /** Live closed-trade count in the window (the sample size). */
  readonly liveTradeCount: number;
}

/** Result of {@link assessEdgeDecay}: the verdict plus the thresholds it used. */
export interface EdgeDecayAssessment {
  readonly verdict: EdgeDecayVerdict;
  /** `baseline * warnFactor`, when a finite baseline PF was available. */
  readonly warnThreshold: number | null;
  /** `baseline * breachFactor`, when a finite baseline PF was available. */
  readonly breachThreshold: number | null;
  /** Plain-language reason, for logs and the UI badge. */
  readonly reason: string;
}

/**
 * Compare a profile's live realized profit factor against its proven backtest
 * baseline and classify the result. Pure: the worker calls it to decide whether
 * to ALERT, and the web scorecard calls it to render the same badge, so the
 * notification and the display can never disagree on the logic.
 *
 * Order of checks matters: monitor-off and no-baseline short-circuit before the
 * sample floor; an absolute floor (live PF < 1, i.e. net-losing) breaches
 * regardless of the baseline, because a profile that is losing money live should
 * raise a heads-up even if its baseline edge was thin.
 */
export function assessEdgeDecay(input: EdgeDecayInput): EdgeDecayAssessment {
  const { policy, hasBaseline, baselineProfitFactor, liveProfitFactor, liveTradeCount } = input;
  if (policy.mode === 'off') {
    return {
      verdict: 'monitor-off',
      warnThreshold: null,
      breachThreshold: null,
      reason: 'monitor off',
    };
  }
  if (!hasBaseline) {
    return {
      verdict: 'no-baseline',
      warnThreshold: null,
      breachThreshold: null,
      reason: 'no baseline backtest pinned',
    };
  }
  if (liveTradeCount < policy.minTrades) {
    return {
      verdict: 'insufficient-data',
      warnThreshold: null,
      breachThreshold: null,
      reason: `${liveTradeCount} live trades (need ${policy.minTrades})`,
    };
  }
  // Absolute floor: a live PF below 1 means net losses exceed net wins — losing
  // money, independent of however thin the baseline edge was.
  if (liveProfitFactor !== null && liveProfitFactor < 1) {
    return {
      verdict: 'breached',
      warnThreshold: null,
      breachThreshold: null,
      reason: `live profit factor ${liveProfitFactor.toFixed(2)} below 1.0 — net-losing`,
    };
  }
  // No finite baseline PF (baseline had no losses) or no live losses yet: there
  // is no decay ratio to compute, and the absolute floor already cleared.
  if (baselineProfitFactor === null || liveProfitFactor === null) {
    return {
      verdict: 'healthy',
      warnThreshold: null,
      breachThreshold: null,
      reason: 'matching or beating baseline',
    };
  }
  const warnThreshold = baselineProfitFactor * policy.warnFactor;
  const breachThreshold = baselineProfitFactor * policy.breachFactor;
  if (liveProfitFactor < breachThreshold) {
    return {
      verdict: 'breached',
      warnThreshold,
      breachThreshold,
      reason: `live PF ${liveProfitFactor.toFixed(2)} below ${breachThreshold.toFixed(2)} (baseline ${baselineProfitFactor.toFixed(2)} × ${policy.breachFactor})`,
    };
  }
  if (liveProfitFactor < warnThreshold) {
    return {
      verdict: 'warning',
      warnThreshold,
      breachThreshold,
      reason: `live PF ${liveProfitFactor.toFixed(2)} below ${warnThreshold.toFixed(2)} (baseline ${baselineProfitFactor.toFixed(2)} × ${policy.warnFactor})`,
    };
  }
  return {
    verdict: 'healthy',
    warnThreshold,
    breachThreshold,
    reason: `live PF ${liveProfitFactor.toFixed(2)} at/above ${warnThreshold.toFixed(2)}`,
  };
}
