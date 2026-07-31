import type { MarketSnapshot } from '@app/strategy-core';
import { Decimal } from '@app/money';
import { ema, sma } from '@app/indicators';
import type { TTConfig, TTRegime } from '../schema.js';

/**
 * The regime filter consults the daily candle. Daily is always subscribed and
 * backfilled for every symbol (worker subscriptions-manager), so a long daily
 * MA is available immediately. Reactivity is set by the configured `period`,
 * not the interval: a 200-day MA is the slow macro regime, a 20-day MA reacts
 * in weeks. A sub-daily regime would whipsaw and duplicate the trade-interval
 * indicator gate, so the interval is fixed here rather than configurable.
 */
export const REGIME_INTERVAL = '1d';

/**
 * Why the promotion was vetoed. Part of the log / metric contract.
 *   - `regime-downtrend`: price is below the daily MA — the macro trend is down.
 *   - `regime-unavailable`: the daily window is too short / absent to evaluate.
 *     Fail-closed (halt the add): the operator opted into the precondition, so
 *     averaging down without confirming the regime is the unsafe direction.
 */
export type RegimeVeto = 'regime-downtrend' | 'regime-unavailable';

export interface RegimeGateResult {
  readonly ok: boolean;
  readonly reason?: RegimeVeto;
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * Opt-in regime filter for trailing-trade grid PROMOTIONS (averaging-down
 * adds), evaluated against a moving average on the daily candle. Halts a
 * promotion when price is below the MA (a higher-timeframe downtrend), so the
 * bot stops catching the falling knife in a sustained bear while still entering
 * fresh and selling normally. The first entry and the sell side are unaffected
 * — the caller only consults this on a promotion.
 *
 * Returns `{ ok: true }` when disabled (the common path) or when price is at or
 * above the MA. Returns a veto otherwise, including the fail-closed
 * `regime-unavailable` case when the daily window is too short to compute.
 *
 * @param market the tick's market snapshot (reads `candlesByInterval['1d']`)
 * @param config the strategy config (reads `regime.onBear.suppressPromotion`)
 */
export const evaluateRegimeFilter = (
  market: MarketSnapshot,
  config: TTConfig,
): RegimeGateResult => {
  // Read tolerantly: the live worker passes the RAW stored profile config to
  // tick() (build-tick-input.ts) without applying schema defaults. Treat a
  // missing block / toggle as disabled — the opt-in default — instead of
  // throwing on `.onBear.suppressPromotion`.
  const regime = config.regime as TTRegime | undefined;
  if (regime?.onBear?.suppressPromotion !== true) return { ok: true };

  const candles = (market.candlesByInterval[REGIME_INTERVAL] ?? []).filter((c) => c.isClosed);
  if (candles.length < regime.period) {
    return {
      ok: false,
      reason: 'regime-unavailable',
      context: { interval: REGIME_INTERVAL, have: candles.length, need: regime.period },
    };
  }
  // Parse the price and compute the MA under one guard: a malformed price or a
  // malformed candle close both mean we cannot confirm the regime, so both
  // fail-closed to regime-unavailable. (The caller validates price before the
  // promotion path, so the price parse is belt-and-braces.)
  let price: Decimal;
  let maValue: Decimal;
  try {
    price = new Decimal(market.currentPrice);
    maValue = regime.ma === 'sma' ? sma(candles, regime.period) : ema(candles, regime.period);
  } catch {
    return {
      ok: false,
      reason: 'regime-unavailable',
      context: { interval: REGIME_INTERVAL, missing: 'compute' },
    };
  }
  if (price.lt(maValue)) {
    return {
      ok: false,
      reason: 'regime-downtrend',
      context: {
        interval: REGIME_INTERVAL,
        price: market.currentPrice,
        ma: maValue.toString(),
        maType: regime.ma,
        period: regime.period,
      },
    };
  }
  return { ok: true };
};
