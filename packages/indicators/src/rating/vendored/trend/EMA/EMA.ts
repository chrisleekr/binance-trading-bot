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
 * Exponential Moving Average (EMA)
 * Type: Trend
 *
 * Compared to SMA, the EMA puts more emphasis on the recent prices to reduce lag. Due to its responsiveness to price changes, it rises faster and falls faster than the SMA when the price is inclining or declining.
 *
 * @see https://www.investopedia.com/terms/e/ema.asp
 */
export class EMA extends MovingAverage {
  #pricesCounter = 0;
  readonly #weightFactor: number;
  override readonly interval: number;

  constructor(interval: number) {
    super(interval);
    this.interval = interval;
    this.#weightFactor = 2 / (this.interval + 1);
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
