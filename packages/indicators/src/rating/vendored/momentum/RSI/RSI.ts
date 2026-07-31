// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { TradingSignal, TrendIndicatorSeries } from '../../types/Indicator.js';
import type { MovingAverage } from '../../trend/MA/MovingAverage.js';
import type { MovingAverageTypes } from '../../trend/MA/MovingAverageTypes.js';
import { pushUpdate } from '../../util/pushUpdate.js';
import { WSMA } from '../../trend/WSMA/WSMA.js';

/**
 * Relative Strength Index (RSI)
 * Type: Momentum
 *
 * The Relative Strength Index (RSI) is an oscillator that ranges between 0 and 100. The RSI can be used to find trend reversals, i.e. when a downtrend doesn't generate a RSI below 30 and rallies above 70 it could mean that a trend reversal to the upside is taking place. Trend lines and moving averages should be used to validate such statements.
 *
 * The RSI is mostly useful in markets that alternate between bullish and bearish movements.
 *
 * Interpretation:
 * A RSI value of 30 or below indicates an oversold condition (not a good time to sell because there is an oversupply).
 * A RSI value of 70 or above indicates an overbought condition (sell high opportunity because market may correct the price in the near future).
 *
 * @see https://en.wikipedia.org/wiki/Relative_strength_index
 * @see https://www.investopedia.com/terms/r/rsi.asp
 */
export class RSI extends TrendIndicatorSeries {
  readonly #previousPrices: number[] = [];
  readonly #avgGain: MovingAverage;
  readonly #avgLoss: MovingAverage;
  readonly #maxValue = 100;

  public readonly interval: number;

  constructor(interval: number, SmoothingIndicator: MovingAverageTypes = WSMA) {
    super();
    this.interval = interval;
    this.#avgGain = new SmoothingIndicator(this.interval);
    this.#avgLoss = new SmoothingIndicator(this.interval);
  }

  override getRequiredInputs() {
    return this.#avgGain.getRequiredInputs();
  }

  update(price: number, replace: boolean) {
    pushUpdate(this.#previousPrices, replace, price, this.interval);

    // Ensure at least 2 prices are available for calculation
    if (this.#previousPrices.length < 2) {
      return null;
    }

    const currentPrice = price;
    const previousPrice = this.#previousPrices[this.#previousPrices.length - 2];

    if (currentPrice > previousPrice) {
      this.#avgLoss.update(0, replace);
      this.#avgGain.update(price - previousPrice, replace);
    } else {
      this.#avgLoss.update(previousPrice - currentPrice, replace);
      this.#avgGain.update(0, replace);
    }

    if (this.#avgGain.isStable) {
      const avgLoss = this.#avgLoss.getResultOrThrow();
      // Prevent division by zero: https://github.com/bennycode/trading-signals/issues/378
      if (avgLoss === 0) {
        return this.setResult(100, replace);
      }
      const relativeStrength = this.#avgGain.getResultOrThrow() / avgLoss;
      return this.setResult(this.#maxValue - this.#maxValue / (relativeStrength + 1), replace);
    }

    return null;
  }

  protected calculateSignalState(result: number | null | undefined) {
    const hasResult = result !== null && result !== undefined;
    const isOversold = hasResult && result <= 30;
    const isOverbought = hasResult && result >= 70;

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
