// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { ATR } from '../../volatility/ATR/ATR.js';
import { IndicatorSeries } from '../../types/Indicator.js';
import type { MovingAverage } from '../MA/MovingAverage.js';
import type { MovingAverageTypes } from '../MA/MovingAverageTypes.js';
import type { HighLowClose } from '../../types/HighLowClose.js';
import { WSMA } from '../WSMA/WSMA.js';

/**
 * Directional Movement Index (DMI / DX)
 * Type: Trend (using +DI & -DI)
 *
 * The DX was developed by John Welles Wilder (Jr.). and may help traders assess the strength of a trend (momentum)
 * and direction of the trend.
 *
 * If there is no change in the trend, then the DX is `0`. The return value increases when there is a stronger trend
 * (either negative or positive). To detect if the trend is bullish or bearish you have to compare +DI and -DI. When
 * +DI is above -DI, then there is more upward pressure than downward pressure in the market.
 *
 * @see https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/dmi
 */
export class DX extends IndicatorSeries<HighLowClose<number>> {
  readonly #movesUp: MovingAverage;
  readonly #movesDown: MovingAverage;
  #previousCandle?: HighLowClose<number>;
  #secondLastCandle?: HighLowClose<number>;
  readonly #atr: ATR;
  public mdi?: number;
  public pdi?: number;

  public readonly interval: number;

  constructor(interval: number, SmoothingIndicator: MovingAverageTypes = WSMA) {
    super();
    this.interval = interval;
    this.#atr = new ATR(this.interval, SmoothingIndicator);
    this.#movesDown = new SmoothingIndicator(this.interval);
    this.#movesUp = new SmoothingIndicator(this.interval);
  }

  #updateState(candle: HighLowClose<number>, pdm: number, mdm: number, replace: boolean): void {
    this.#atr.update(candle, replace);
    this.#movesUp.update(pdm, replace);
    this.#movesDown.update(mdm, replace);
    if (this.#previousCandle) {
      this.#secondLastCandle = this.#previousCandle;
    }
    this.#previousCandle = candle;
  }

  override getRequiredInputs() {
    return this.#movesUp.getRequiredInputs();
  }

  update(candle: HighLowClose<number>, replace: boolean) {
    if (!this.#previousCandle) {
      this.#updateState(candle, 0, 0, replace);
      return null;
    }

    if (this.#secondLastCandle && replace) {
      this.#previousCandle = this.#secondLastCandle;
    }

    const currentHigh = candle.high;
    const previousHigh = this.#previousCandle.high;

    const currentLow = candle.low;
    const previousLow = this.#previousCandle.low;

    const higherHigh = currentHigh - previousHigh;
    const lowerLow = previousLow - currentLow;

    const noHigherHighs = higherHigh < 0;
    const lowsRise = higherHigh < lowerLow;

    const pdm = noHigherHighs || lowsRise ? 0 : higherHigh;

    const noLowerLows = lowerLow < 0;
    const highsRise = lowerLow < higherHigh;

    const mdm = noLowerLows || highsRise ? 0 : lowerLow;

    this.#updateState(candle, pdm, mdm, replace);

    if (this.#movesUp.isStable) {
      this.pdi = this.#movesUp.getResultOrThrow() / this.#atr.getResultOrThrow();
      this.mdi = this.#movesDown.getResultOrThrow() / this.#atr.getResultOrThrow();

      const dmDiff = Math.abs(this.pdi - this.mdi);
      const dmSum = this.pdi + this.mdi;

      if (dmSum === 0) {
        return this.setResult(0, replace);
      }

      return this.setResult((dmDiff / dmSum) * 100, replace);
    }

    return null;
  }
}
