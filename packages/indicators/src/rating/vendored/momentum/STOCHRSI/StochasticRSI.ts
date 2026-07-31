// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import type { MovingAverage } from '../../trend/MA/MovingAverage.js';
import type { MovingAverageTypes } from '../../trend/MA/MovingAverageTypes.js';
import { SMA } from '../../trend/SMA/SMA.js';
import { WSMA } from '../../trend/WSMA/WSMA.js';
import { TradingSignal, TrendIndicatorSeries } from '../../types/Indicator.js';
import { Period } from '../../types/Period.js';
import { RSI } from '../RSI/RSI.js';

/**
 * Stochastic RSI (STOCHRSI)
 * Type: Momentum
 *
 * The Stochastic RSI is an oscillator ranging from 0 to 1 and was developed by Tushar S. Chande and Stanley Kroll.
 * Compared to the RSI, the Stochastic RSI is much steeper and often resides at the extremes (0 or 1). It can be used to identify short-term trends.
 *
 * - A return value of 0.2 or below indicates an oversold condition
 * - A return value around 0.5 indicates a neutral market
 * - A return value of 0.8 or above indicates an overbought condition
 * - Overbought doesn't mean that the price will reverse lower but it shows that the RSI reached an extreme
 * - Oversold doesn't mean that the price will reverse higher but it shows that the RSI reached an extreme
 *
 * The Stochastic RSI is often read through crossovers of its %K (fast) and %D (signal) lines. A %K crossing above %D in the oversold zone (below 20) may suggest a buy, while a %K crossing below %D in the overbought zone (above 80) can signal a potential sell.
 *
 * @see https://www.investopedia.com/terms/s/stochrsi.asp
 * @see https://lakshmishree.com/blog/stochastic-rsi-indicator/
 * @see https://alchemymarkets.com/education/indicators/stochastic-rsi/
 */
export class StochasticRSI extends TrendIndicatorSeries {
  readonly #period: Period;
  readonly #rsi: RSI;

  public readonly interval: number;
  public readonly smoothing: {
    readonly k: MovingAverage;
    readonly d: MovingAverage;
  };

  constructor(
    interval: number,
    SmoothingRSI: MovingAverageTypes = WSMA,
    smoothing: {
      readonly k: MovingAverage;
      readonly d: MovingAverage;
    } = {
      d: new SMA(3),
      k: new SMA(3),
    },
  ) {
    super();
    this.interval = interval;
    this.smoothing = smoothing;
    this.#period = new Period(interval);
    this.#rsi = new RSI(interval, SmoothingRSI);
  }

  override getRequiredInputs() {
    return this.#rsi.getRequiredInputs() + this.#period.getRequiredInputs();
  }

  update(price: number, replace: boolean) {
    const rsiResult = this.#rsi.update(price, replace);
    if (rsiResult) {
      const periodResult = this.#period.update(rsiResult, replace);
      if (periodResult) {
        const min = periodResult.lowest;
        const max = periodResult.highest;
        const denominator = max - min;
        // Prevent division by zero: https://github.com/bennycode/trading-signals/issues/378
        if (denominator === 0) {
          return this.setResult(100, replace);
        }
        const numerator = rsiResult - min;
        const stochRSI = numerator / denominator;
        const k = this.smoothing.k.update(stochRSI, replace);
        if (k) {
          this.smoothing.d.update(k, replace);
        }
        return this.setResult(stochRSI, replace);
      }
    }

    return null;
  }

  protected calculateSignalState(result?: number | null | undefined) {
    const hasResult = result !== null && result !== undefined;
    const isOversold = hasResult && result <= 0.2;
    const isOverbought = hasResult && result >= 0.8;

    switch (true) {
      case !hasResult:
        return TradingSignal.UNKNOWN;
      case isOversold:
        return TradingSignal.BEARISH;
      case isOverbought:
        return TradingSignal.BULLISH;
      default:
        return TradingSignal.SIDEWAYS;
    }
  }
}
