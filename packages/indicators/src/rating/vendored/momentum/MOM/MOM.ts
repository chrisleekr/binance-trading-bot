// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { TradingSignal, TrendIndicatorSeries } from '../../types/Indicator.js';
import { pushUpdate } from '../../util/pushUpdate.js';

/**
 * Momentum Indicator (MOM / MTM)
 * Type: Momentum
 *
 * The Momentum indicator returns the change between the current price and the price n times ago.
 *
 * @see https://en.wikipedia.org/wiki/Momentum_(technical_analysis)
 * @see https://www.warriortrading.com/momentum-indicator/
 */
export class MOM extends TrendIndicatorSeries {
  readonly #history: number[];
  readonly #historyLength: number;

  public readonly interval: number;

  constructor(interval: number) {
    super();
    this.interval = interval;
    this.#historyLength = interval + 1;
    this.#history = [];
  }

  override getRequiredInputs() {
    return this.#historyLength;
  }

  update(value: number, replace: boolean) {
    pushUpdate(this.#history, replace, value, this.#historyLength);

    if (this.#history.length === this.#historyLength) {
      return this.setResult(value - this.#history[0], replace);
    }

    return null;
  }

  protected calculateSignalState(result?: number | null | undefined) {
    const hasResult = result !== null && result !== undefined;

    if (!hasResult) {
      return TradingSignal.UNKNOWN;
    }

    if (result > 0) {
      return TradingSignal.BULLISH;
    }

    if (result < 0) {
      return TradingSignal.BEARISH;
    }

    return TradingSignal.SIDEWAYS;
  }
}
