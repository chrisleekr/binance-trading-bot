// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { IndicatorSeries } from '../../types/Indicator.js';
import type { HighLowClose } from '../../types/HighLowClose.js';

/**
 * True Range (TR)
 * Type: Volatility
 *
 * The True Range (TR) was developed by John Welles Wilder (Jr.). The range (R) is a candle's highest price minus it's lowest price. The true range extends it to yesterday's closing price if it was outside of the current range.
 *
 * Low return values indicate a sideways trend with little volatility.
 *
 * @see https://www.linnsoft.com/techind/true-range-tr
 */
export class TR extends IndicatorSeries<HighLowClose<number>> {
  #previousCandle?: HighLowClose<number>;
  #twoPreviousCandle?: HighLowClose<number>;

  override getRequiredInputs() {
    return 2;
  }

  update(candle: HighLowClose<number>, replace: boolean): number {
    const { high, low } = candle;
    const highLow = high - low;

    if (this.#previousCandle && replace) {
      this.#previousCandle = this.#twoPreviousCandle;
    }

    if (this.#previousCandle) {
      const highClose = Math.abs(high - this.#previousCandle.close);
      const lowClose = Math.abs(low - this.#previousCandle.close);
      this.#twoPreviousCandle = this.#previousCandle;
      this.#previousCandle = candle;
      return this.setResult(Math.max(highLow, highClose, lowClose), replace);
    }
    this.#twoPreviousCandle = this.#previousCandle;
    this.#previousCandle = candle;
    return this.setResult(highLow, replace);
  }
}
