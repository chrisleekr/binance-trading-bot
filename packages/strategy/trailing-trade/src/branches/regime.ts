import type { Candle, MarketSnapshot } from '@app/strategy-core';
import { Decimal } from '@app/money';
import { ema, sma } from '@app/indicators';
import { REGIME_INTERVAL } from './regime-filter.js';
import { safeDecimal } from './safe-decimal.js';

/**
 * Daily-regime classification, the single signal every regime-aware behaviour
 * subscribes to.
 *
 *   - `bull`        : the last `confirmBars` CLOSED daily candles all closed
 *     ABOVE the regime MA — a confirmed higher-timeframe uptrend.
 *   - `bear`        : the last `confirmBars` closed daily candles all closed
 *     BELOW the MA — a confirmed downtrend (the cash-rotation exit's trigger).
 *   - `neutral`     : enabled and computable, but the confirmation window is
 *     mixed (some above, some below, or touching the line).
 *   - `unavailable` : the daily window is too short to compute the MA or to fill
 *     the confirmation window. Callers decide fail-safe vs fail-closed.
 *
 * `bull`/`bear` are exact mirrors (all strictly above vs all strictly below);
 * an equal-to-MA close is neither, so it falls to `neutral`. Closes-only (not
 * the instantaneous price) is what makes the verdict whipsaw-resistant near the
 * line. Pure and stateless: it reads the daily candle window the tick already
 * carries, so no persisted hysteresis state is needed.
 */
export type Regime = 'bull' | 'bear' | 'neutral' | 'unavailable';

export interface RegimeParams {
  readonly ma: 'sma' | 'ema';
  readonly period: number;
  readonly confirmBars: number;
}

export interface RegimeReading {
  readonly regime: Regime;
  readonly context: Readonly<Record<string, unknown>>;
}

/**
 * Classify the daily regime from a moving average plus a closes-only
 * confirmation window.
 *
 * @param market the tick's market snapshot (reads `candlesByInterval['1d']`)
 * @param params the regime MA definition (`ma` / `period` / `confirmBars`)
 */
/**
 * Regime core: classify from a daily candle window + the current price directly,
 * so a caller without a full {@link MarketSnapshot} (the config preview) reuses
 * the exact worker classification instead of a divergent copy.
 */
export const classifyRegimeFromDaily = (
  dailyCandles: readonly Candle[],
  currentPrice: string,
  params: RegimeParams,
): RegimeReading => {
  const candles = dailyCandles.filter((c) => c.isClosed);
  // `Math` is banned in strategy packages — clamp the window need with a ternary
  // (mirrors grid-buy.ts). Need `period` candles for the MA AND `confirmBars`
  // closes to confirm.
  const need = params.period > params.confirmBars ? params.period : params.confirmBars;
  if (candles.length < need) {
    return {
      regime: 'unavailable',
      context: { interval: REGIME_INTERVAL, have: candles.length, need },
    };
  }

  // Parse the confirmation closes first so a malformed recent close fails safe
  // to `unavailable` before the MA is computed.
  const lastBars = candles.slice(candles.length - params.confirmBars);
  const closes: Decimal[] = [];
  for (const c of lastBars) {
    const close = safeDecimal(c.close);
    if (close === null) {
      return { regime: 'unavailable', context: { interval: REGIME_INTERVAL, missing: 'close' } };
    }
    closes.push(close);
  }

  let maValue: Decimal;
  try {
    maValue = params.ma === 'sma' ? sma(candles, params.period) : ema(candles, params.period);
  } catch {
    // A malformed close inside the MA window (older than the confirmation bars)
    // makes the regime uncomputable — fail safe.
    return { regime: 'unavailable', context: { interval: REGIME_INTERVAL, missing: 'compute' } };
  }

  const context = {
    interval: REGIME_INTERVAL,
    ma: maValue.toString(),
    maType: params.ma,
    period: params.period,
    confirmBars: params.confirmBars,
    price: currentPrice,
  };
  if (closes.every((close) => close.lt(maValue))) return { regime: 'bear', context };
  if (closes.every((close) => close.gt(maValue))) return { regime: 'bull', context };
  return { regime: 'neutral', context };
};

export const classifyRegime = (market: MarketSnapshot, params: RegimeParams): RegimeReading =>
  classifyRegimeFromDaily(
    market.candlesByInterval[REGIME_INTERVAL] ?? [],
    market.currentPrice,
    params,
  );
