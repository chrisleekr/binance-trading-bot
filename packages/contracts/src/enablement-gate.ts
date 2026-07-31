/**
 * Pure evaluation of the live-enablement edge gate: does a recent backtest, run
 * on a profile's CURRENT config, clear the net-of-fee thresholds?
 *
 * Extracted so one function answers the question for two callers that must never
 * disagree: the API admission check (throws at enable-time) and the `GET
 * /gate-status` route that renders the dashboard advisory. Keeping the logic
 * here — pure, transport-agnostic — means "can this go live" and "is this config
 * still proven" are the same computation.
 */

import { z } from 'zod';
import { BacktestResultSchema } from './backtest.js';

/** The three gate-relevant figures, shared by the full run and its holdout. */
export interface GateMetricsCore {
  /** Net profit factor (gross win / gross loss); `null` when there were no losses. */
  readonly profitFactor: number | null;
  /** Closed-trade count. */
  readonly totalTrades: number;
  /**
   * Strategy return (net of its trading fees) minus a FEE-FREE buy-and-hold, in
   * percent. Conservative: the hold benchmark pays no fees, so the strategy had
   * to overcome its own to show positive alpha.
   */
  readonly alphaVsHoldPct: number;
}

/** Gate-relevant metrics pulled from a backtest run's result. */
export interface GateMetrics extends GateMetricsCore {
  /**
   * The same three figures over the out-of-sample holdout (most-recent slice of
   * the run), or `null` when the run carries no holdout (persisted before the
   * field shipped, or too short to carve one). When `requireOutOfSample` is on,
   * `null` fails the gate.
   */
  readonly outOfSample: GateMetricsCore | null;
  /**
   * False when the run carried data-coverage warnings (a symbol was sparse — a
   * halt, delisting, or thin liquidity), so its metrics are computed on
   * unreliable data and must not unlock live trading. `true`/absent passes:
   * absent keeps runs predating the check from being retroactively blocked
   * (`toGateCandidates` always sets it for current runs).
   */
  readonly dataCoverageOk?: boolean;
}

/** One candidate backtest run, mapped from a `backtest_runs` row by the caller. */
export interface GateCandidate {
  readonly runId: string;
  /** Fingerprint of the config the run executed; `null` for runs predating the column. */
  readonly configFingerprint: string | null;
  /** When the run was created (epoch ms), for the staleness check. */
  readonly createdAtMs: number;
  /** Parsed metrics, or `null` when the stored result was unreadable. */
  readonly metrics: GateMetrics | null;
}

/** The numeric thresholds the gate enforces (a subset of `EnablementPolicy`). */
export interface GatePolicyThresholds {
  readonly minProfitFactor: number;
  readonly minTrades: number;
  readonly minAlphaVsHoldPct: number;
  readonly maxBacktestAgeDays: number;
  readonly requireOutOfSample: boolean;
  readonly minOutOfSampleTrades: number;
}

/** One threshold check, surfaced so callers can render which metric failed. */
export interface GateCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly actual: string;
  readonly need: string;
}

/** The numeric quality thresholds (the freshness-independent subset). */
export interface GateThresholds {
  readonly minProfitFactor: number;
  readonly minTrades: number;
  readonly minAlphaVsHoldPct: number;
  readonly requireOutOfSample: boolean;
  readonly minOutOfSampleTrades: number;
}

/**
 * Build the per-criterion threshold checks for a set of metrics. The single
 * source of the gate's profit-factor / trade-count / alpha checks, so the
 * admission gate (via {@link evaluateBacktestGate}) and the backtest-results
 * scorecard render identical pass/fail criteria and can never drift. Pure;
 * answers only "do these metrics clear the bar", not match/freshness.
 */
export function gateThresholdChecks(
  metrics: GateMetrics,
  thresholds: GateThresholds,
): readonly GateCheck[] {
  const checks: GateCheck[] = [
    {
      // Data quality gates first: metrics from sparse/holed candle data are not
      // trustworthy, so a coverage breach blocks live no matter how good the
      // numbers look (fails closed).
      label: 'data coverage',
      ok: metrics.dataCoverageOk !== false,
      actual: metrics.dataCoverageOk === false ? 'gaps' : 'complete',
      need: 'no gaps',
    },
    {
      label: 'profit factor',
      ok: metrics.profitFactor !== null && metrics.profitFactor >= thresholds.minProfitFactor,
      actual: metrics.profitFactor === null ? 'n/a' : metrics.profitFactor.toFixed(2),
      need: `>= ${thresholds.minProfitFactor}`,
    },
    {
      label: 'closed trades',
      ok: metrics.totalTrades >= thresholds.minTrades,
      actual: String(metrics.totalTrades),
      need: `>= ${thresholds.minTrades}`,
    },
    {
      label: 'alpha vs hold',
      ok: metrics.alphaVsHoldPct >= thresholds.minAlphaVsHoldPct,
      actual: `${metrics.alphaVsHoldPct.toFixed(2)}%`,
      need: `>= ${thresholds.minAlphaVsHoldPct}%`,
    },
  ];

  // Out-of-sample defence against curve-fitting: the edge must clear the same
  // profit-factor and alpha bars in the holdout (most-recent slice the tuning
  // never targeted). A run with no holdout — too short, or persisted before the
  // field shipped — fails the check, so the operator re-runs the backtest.
  if (thresholds.requireOutOfSample) {
    const oos = metrics.outOfSample;
    if (oos === null) {
      checks.push({
        label: 'out-of-sample validation',
        ok: false,
        actual: 'missing',
        need: 're-run backtest',
      });
    } else {
      checks.push(
        {
          label: 'out-of-sample trades',
          ok: oos.totalTrades >= thresholds.minOutOfSampleTrades,
          actual: String(oos.totalTrades),
          need: `>= ${thresholds.minOutOfSampleTrades}`,
        },
        {
          label: 'out-of-sample profit factor',
          ok: oos.profitFactor !== null && oos.profitFactor >= thresholds.minProfitFactor,
          actual: oos.profitFactor === null ? 'n/a' : oos.profitFactor.toFixed(2),
          need: `>= ${thresholds.minProfitFactor}`,
        },
        {
          label: 'out-of-sample alpha vs hold',
          ok: oos.alphaVsHoldPct >= thresholds.minAlphaVsHoldPct,
          actual: `${oos.alphaVsHoldPct.toFixed(2)}%`,
          need: `>= ${thresholds.minAlphaVsHoldPct}%`,
        },
      );
    }
  }

  return checks;
}

/**
 * Result of {@link evaluateBacktestGate}. `ok` means a recent matching backtest
 * cleared every threshold. The failure variants mirror the admission gate's
 * error cases so the API can rebuild its exact messages and the worker can log a
 * concise reason — both from the same structured outcome.
 */
export type GateOutcome =
  | { readonly ok: true; readonly runId: string; readonly matchedAtMs: number }
  | { readonly ok: false; readonly failure: 'no-matching-backtest' }
  | {
      readonly ok: false;
      readonly failure: 'stale';
      readonly runId: string;
      readonly ageDays: number;
    }
  | { readonly ok: false; readonly failure: 'unreadable-result'; readonly runId: string }
  | {
      readonly ok: false;
      readonly failure: 'thresholds';
      readonly runId: string;
      readonly checks: readonly GateCheck[];
    };

export interface GateEvalInput {
  readonly policy: GatePolicyThresholds;
  /** Fingerprint of the profile's current config. */
  readonly currentFingerprint: string;
  /** Recent done standalone runs, newest-first (the order `recentDone` returns). */
  readonly candidates: readonly GateCandidate[];
  readonly nowMs: number;
}

const DAY_MS = 86_400_000;

/**
 * How many recent done standalone runs to scan for a config match. A profile
 * accumulates few standalone backtests; 25 covers "the operator re-ran it a few
 * times" without an unbounded read. Shared by the admission gate and the
 * continuous enforcer so both scan the same depth.
 */
export const RECENT_DONE_SCAN = 25;

/**
 * Find the newest backtest run matching the current config fingerprint and check
 * it against the gate thresholds. Callers handle the policy master switch and the
 * live-mode guard; this answers only "is there proof for this exact config".
 *
 * Order matches the admission gate: match → freshness → readability → thresholds.
 */
export function evaluateBacktestGate(input: GateEvalInput): GateOutcome {
  const { policy, currentFingerprint, candidates, nowMs } = input;
  const matching = candidates.find((c) => c.configFingerprint === currentFingerprint);
  if (!matching) return { ok: false, failure: 'no-matching-backtest' };

  const ageDays = (nowMs - matching.createdAtMs) / DAY_MS;
  if (ageDays > policy.maxBacktestAgeDays) {
    return { ok: false, failure: 'stale', runId: matching.runId, ageDays };
  }

  if (matching.metrics === null) {
    return { ok: false, failure: 'unreadable-result', runId: matching.runId };
  }

  const checks = gateThresholdChecks(matching.metrics, policy);
  if (checks.some((c) => !c.ok)) {
    return { ok: false, failure: 'thresholds', runId: matching.runId, checks };
  }
  return { ok: true, runId: matching.runId, matchedAtMs: matching.createdAtMs };
}

/** Join the failed threshold checks into the admission gate's `detail` phrasing. */
export function failedChecksDetail(checks: readonly GateCheck[]): string {
  return checks
    .filter((c) => !c.ok)
    .map((c) => `${c.label} ${c.actual} (need ${c.need})`)
    .join('; ');
}

/** Minimal `backtest_runs` row shape {@link toGateCandidates} needs. */
export interface BacktestRunLike {
  readonly id: string;
  readonly configFingerprint: string | null;
  readonly createdAt: Date;
  readonly result: unknown;
}

/**
 * Map `backtest_runs` rows (newest-first) to gate candidates, parsing each result
 * for metrics. The single adapter shared by the API admission gate, the API
 * gate-status route, and the worker enforcer cron, so all three feed
 * {@link evaluateBacktestGate} identically.
 */
export function toGateCandidates(rows: readonly BacktestRunLike[]): GateCandidate[] {
  return rows.map((r) => {
    const res = BacktestResultSchema.safeParse(r.result);
    return {
      runId: r.id,
      configFingerprint: r.configFingerprint,
      createdAtMs: r.createdAt.getTime(),
      metrics: res.success
        ? {
            profitFactor: res.data.metrics.profitFactor,
            totalTrades: res.data.metrics.totalTrades,
            alphaVsHoldPct: res.data.metrics.alphaVsHoldPct,
            dataCoverageOk: res.data.dataWarnings.length === 0,
            outOfSample: res.data.outOfSample
              ? {
                  profitFactor: res.data.outOfSample.profitFactor,
                  totalTrades: res.data.outOfSample.trades,
                  alphaVsHoldPct: res.data.outOfSample.alphaVsHoldPct,
                }
              : null,
          }
        : null,
    };
  });
}

/**
 * Plain-language one-liner for a gate outcome, shared by the worker halt log and
 * the gate-status UI so they read the same. Pure.
 */
export function describeGateOutcome(outcome: GateOutcome): string {
  if (outcome.ok) return 'current config is validated by a recent passing backtest';
  switch (outcome.failure) {
    case 'no-matching-backtest':
      return 'no recent backtest was run on the current configuration';
    case 'stale':
      return `the matching backtest is ${Math.floor(outcome.ageDays)} days old`;
    case 'unreadable-result':
      return 'the matching backtest result could not be read';
    case 'thresholds':
      return `the backtest does not clear the gate — ${failedChecksDetail(outcome.checks)}`;
  }
}

/**
 * Live-gate status for one profile, served by `GET /profiles/:id/gate-status` and
 * rendered by the gate-status card. `applicability` is `not-live` for testnet
 * profiles (the gate only guards real money) and `gate-off` when the policy master
 * switch is off; otherwise `gated`. `ok`/`failure`/`detail` describe whether the
 * current config clears the gate. This is an advisory surface only — the bot
 * never pauses buys for a failing gate; it just flags the problem here.
 */
export const GateStatusResponse = z.object({
  applicability: z.enum(['gated', 'not-live', 'gate-off']),
  ok: z.boolean(),
  failure: z.enum(['no-matching-backtest', 'stale', 'unreadable-result', 'thresholds']).nullable(),
  detail: z.string(),
});
export type GateStatusResponse = z.infer<typeof GateStatusResponse>;
