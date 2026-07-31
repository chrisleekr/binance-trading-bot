// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { EMA } from '../EMA/EMA.js';
import { IndicatorSeries } from '../../types/Indicator.js';

/**
 * Double Exponential Moving Average (DEMA)
 * Type: Trend
 *
 * The Double Exponential Moving Average (DEMA) was developed by Patrick G. Mulloy. It attempts to remove the lag associated with Moving Averages by placing more weight on recent values. It has its name because the value of an EMA is doubled which makes it responds more quickly to short-term price changes than a normal EMA.
 *
 * @see https://www.investopedia.com/terms/d/double-exponential-moving-average.asp
 */
export class DEMA extends IndicatorSeries {
  readonly #inner: EMA;
  readonly #outer: EMA;

  public readonly interval: number;

  constructor(interval: number) {
    super();
    this.interval = interval;
    this.#inner = new EMA(interval);
    this.#outer = new EMA(interval);
  }

  override getRequiredInputs() {
    return this.#outer.getRequiredInputs();
  }

  update(price: number, replace: boolean): number {
    const innerResult = this.#inner.update(price, replace);
    const outerResult = this.#outer.update(innerResult, replace);
    return this.setResult(innerResult * 2 - outerResult, replace);
  }

  override get isStable(): boolean {
    return this.#outer.isStable;
  }
}
