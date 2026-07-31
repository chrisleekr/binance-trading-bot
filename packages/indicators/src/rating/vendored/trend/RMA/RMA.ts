// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { MovingAverage } from '../MA/MovingAverage.js';
import { NotEnoughDataError } from '../../error/index.js';

/**
 * Relative Moving Average (RMA)
 * Type: Trend
 *
 * Use RMA to identify bullish or bearish trends. It provides a smoother curve compared to SMA and EMA, reacting more slowly to price changes.
 *
 * @see https://www.tradingcode.net/tradingview/ema-versus-rma/
 * @see https://www.tradingcode.net/tradingview/relative-moving-average/#calculation-process
 */
export class RMA extends MovingAverage {
  #pricesCounter = 0;
  readonly #weightFactor: number;
  override readonly interval: number;

  constructor(interval: number) {
    super(interval);
    this.interval = interval;
    this.#weightFactor = 1 / this.interval;
  }

  override getRequiredInputs() {
    return this.interval;
  }

  update(price: number, replace: boolean): number {
    if (!replace) {
      this.#pricesCounter++;
    } else if (replace && this.#pricesCounter === 0) {
      this.#pricesCounter++;
    }

    if (replace && this.previousResult !== undefined) {
      return this.setResult(
        price * this.#weightFactor + this.previousResult * (1 - this.#weightFactor),
        replace,
      );
    }
    return this.setResult(
      price * this.#weightFactor +
        (this.result !== undefined ? this.result : price) * (1 - this.#weightFactor),
      replace,
    );
  }

  override getResultOrThrow(): number {
    if (this.#pricesCounter < this.interval) {
      throw new NotEnoughDataError(this.getRequiredInputs());
    }

    return this.result!;
  }

  override get isStable(): boolean {
    try {
      this.getResultOrThrow();
      return true;
    } catch {
      return false;
    }
  }
}
