// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { MovingAverage } from '../MA/MovingAverage.js';
import { pushUpdate } from '../../util/pushUpdate.js';

/**
 * Weighted Moving Average (WMA)
 * Type: Trend
 *
 * Compared to SMA, the WMA puts more emphasis on the recent prices to reduce lag. Due to its responsiveness to price changes, it rises faster and falls faster than the SMA when the price is inclining or declining.
 *
 * @see https://corporatefinanceinstitute.com/resources/career-map/sell-side/capital-markets/weighted-moving-average-wma/
 */
export class WMA extends MovingAverage {
  public readonly prices: number[] = [];
  override readonly interval: number;

  constructor(interval: number) {
    super(interval);
    this.interval = interval;
  }

  override getRequiredInputs() {
    return this.interval;
  }

  update(price: number, replace: boolean) {
    pushUpdate(this.prices, replace, price, this.interval);

    if (this.prices.length === this.interval) {
      const weightedPricesSum = this.prices.reduce((acc: number, price: number, index: number) => {
        const weightedPrice = price * (index + 1);

        return acc + weightedPrice;
      }, 0);

      const weightBase = (this.interval * (this.interval + 1)) / 2; // the numerator will always be even and the value will be an int.
      const weightedMa = weightedPricesSum / weightBase;

      return this.setResult(weightedMa, replace);
    }

    return null;
  }
}
