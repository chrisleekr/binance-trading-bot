// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { IndicatorSeries } from '../../types/Indicator.js';
import { getAverage, pushUpdate } from '../../util/index.js';

/**
 * Mean Absolute Deviation (MAD)
 * Type: Volatility
 *
 * The mean absolute deviation (MAD) is calculating the absolute deviation / difference from the mean over a period. Large outliers will reflect in a higher MAD.
 *
 * @see https://en.wikipedia.org/wiki/Average_absolute_deviation
 */
export class MAD extends IndicatorSeries {
  public readonly prices: number[] = [];

  public readonly interval: number;

  constructor(interval: number) {
    super();
    this.interval = interval;
  }

  override getRequiredInputs() {
    return this.interval;
  }

  update(price: number, replace: boolean) {
    pushUpdate(this.prices, replace, price, this.interval);

    if (this.prices.length === this.interval) {
      const mean = getAverage(this.prices);
      let sum = 0;
      for (let i = 0; i < this.interval; i++) {
        const deviation = Math.abs(this.prices[i] - mean);
        sum += deviation;
      }
      return this.setResult(sum / this.interval, replace);
    }

    return null;
  }

  static getResultFromBatch(prices: number[], average?: number): number {
    if (prices.length === 0) {
      return 0;
    }
    const mean = average || getAverage(prices);
    let sum = 0;
    for (let i = 0; i < prices.length; i++) {
      const deviation = Math.abs(prices[i] - mean);
      sum += deviation;
    }
    return sum / prices.length;
  }
}
