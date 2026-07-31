import {
  gateThresholdChecks,
  type BacktestMetrics,
  type EnablementPolicy,
  type GateCheck,
  type OutOfSampleSegment,
} from '@app/contracts';

/**
 * Map a finished run's metrics + holdout into the candidate shape the live-gate
 * check (`gateThresholdChecks`) reads. Shared by the gate scorecard and the
 * backtest route so the two can never drift in how they feed the gate.
 */
export function gateCandidate(
  metrics: BacktestMetrics,
  outOfSample: OutOfSampleSegment | null,
  dataWarnings: readonly string[],
) {
  return {
    profitFactor: metrics.profitFactor,
    totalTrades: metrics.totalTrades,
    alphaVsHoldPct: metrics.alphaVsHoldPct,
    dataCoverageOk: dataWarnings.length === 0,
    outOfSample: outOfSample
      ? {
          profitFactor: outOfSample.profitFactor,
          totalTrades: outOfSample.trades,
          alphaVsHoldPct: outOfSample.alphaVsHoldPct,
        }
      : null,
  };
}

/**
 * The live-gate threshold checks a finished run FAILS, against a policy. Shared
 * by the scorecard (renders every check) and the diagnosis spine (surfaces only
 * the failures), so the two read the gate identically.
 */
export function failedGateChecks(
  metrics: BacktestMetrics,
  outOfSample: OutOfSampleSegment | null,
  dataWarnings: readonly string[],
  policy: EnablementPolicy,
): readonly GateCheck[] {
  return gateThresholdChecks(gateCandidate(metrics, outOfSample, dataWarnings), policy).filter(
    (c) => !c.ok,
  );
}
