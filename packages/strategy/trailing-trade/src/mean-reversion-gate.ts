import type { MarketSnapshot } from '@app/strategy-core';
import { sma, stddev } from '@app/indicators';
import { Decimal } from '@app/money';
import type { IndicatorGateResult } from './indicator-gate.js';
import type { TTConfig, TTMeanReversionGate } from './schema.js';

/**
 * Mean-reversion entry gate — a research-harness signal distinct from the
 * momentum/trend indicator gate. Computes the price z-score
 * `(currentPrice - SMA) / stddev` over `lookbackCandles` of the configured
 * Candle Interval and vetoes the buy unless that z-score is at or below
 * `entryZScoreMax`. A negative ceiling buys statistical dips; a high positive
 * ceiling is effectively off. Returns the same {@link IndicatorGateResult}
 * union as {@link evaluateIndicatorGate}, so the caller surfaces it through the
 * existing indicator-veto channel.
 *
 * Computed from `market.candlesByInterval` (present in both the live worker and
 * the backtest) rather than the precomputed indicator snapshot, so it needs no
 * snapshot plumbing. Fail-closed: an armed gate with a window shorter than the
 * lookback, a missing price, or a flat (zero-stddev) window vetoes with
 * `indicator-unavailable` rather than letting an unchecked buy through — the
 * operator opted into the precondition. Disabled (`entryZScoreMax === ''`)
 * short-circuits to `{ ok: true }`, so a non-opted-in profile is unchanged.
 */
export const evaluateMeanReversionGate = (
  market: MarketSnapshot,
  config: TTConfig,
): IndicatorGateResult => {
  // Schema-defaulted, but a config row serialised before the field existed can
  // reach here without it; treat a missing gate as disabled (matches the
  // indicator-gate's tolerance).
  const gate: TTMeanReversionGate | undefined = config.buy.meanReversionGate;
  if (gate === undefined || gate.entryZScoreMax === '') return { ok: true };

  const interval = config.candleInterval;
  const window = market.candlesByInterval[interval];
  const lookback = gate.lookbackCandles;
  if (window === undefined || window.length < lookback) {
    return {
      ok: false,
      reason: 'indicator-unavailable',
      context: { interval, missing: 'mean-reversion-window', have: window?.length ?? 0, lookback },
    };
  }

  let price: Decimal;
  let mean: Decimal;
  let sd: Decimal;
  try {
    price = new Decimal(market.currentPrice);
    mean = sma(window, lookback);
    sd = stddev(window, lookback);
  } catch {
    return { ok: false, reason: 'indicator-unavailable', context: { interval, missing: 'parse' } };
  }
  if (sd.isZero()) {
    // Flat window → z-score undefined; do not divide by zero or guess.
    return { ok: false, reason: 'indicator-unavailable', context: { interval, missing: 'stddev' } };
  }

  const z = price.minus(mean).dividedBy(sd);
  const ceiling = new Decimal(gate.entryZScoreMax);
  if (z.gt(ceiling)) {
    return {
      ok: false,
      reason: 'indicator-mean-reversion',
      context: {
        interval,
        zScore: z.toString(),
        entryZScoreMax: gate.entryZScoreMax,
        lookbackCandles: lookback,
      },
    };
  }
  return { ok: true };
};
