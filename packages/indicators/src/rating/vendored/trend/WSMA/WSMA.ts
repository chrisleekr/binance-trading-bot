// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { IndicatorSeries } from '../../types/Indicator.js';
import { SMA } from '../SMA/SMA.js';

/**
 * Wilder's Smoothed Moving Average (WSMA)
 * Type: Trend
 *
 * Developed by John Welles Wilder (Jr.) to help identifying and spotting bullish and bearish trends. Similar to
 * Exponential Moving Averages with the difference that a smoothing factor of 1/interval is being used, which makes it
 * respond more slowly to price changes.
 *
 * Synonyms:
 * - Modified Exponential Moving Average (MEMA)
 * - Smoothed Moving Average (SMMA)
 * - Welles Wilder's Smoothing (WWS)
 *
 * @see https://tlc.thinkorswim.com/center/reference/Tech-Indicators/studies-library/V-Z/WildersSmoothing
 */
export class WSMA extends IndicatorSeries {
  readonly #indicator: SMA;
  readonly #smoothingFactor: number;

  public readonly interval: number;

  constructor(interval: number) {
    super();
    this.interval = interval;
    this.#indicator = new SMA(interval);
    this.#smoothingFactor = 1 / this.interval;
  }

  override getRequiredInputs() {
    return this.interval;
  }

  update(price: number, replace: boolean) {
    const sma = this.#indicator.update(price, replace);
    if (replace && this.previousResult !== undefined) {
      const smoothed = (price - this.previousResult) * this.#smoothingFactor;
      return this.setResult(smoothed + this.previousResult, replace);
    } else if (!replace && this.result !== undefined) {
      const smoothed = (price - this.result) * this.#smoothingFactor;
      return this.setResult(smoothed + this.result, replace);
    } else if (this.result === undefined && sma !== null) {
      return this.setResult(sma, replace);
    }

    return null;
  }
}
