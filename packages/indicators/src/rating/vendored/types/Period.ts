// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { TechnicalIndicator } from './Indicator.js';
import { pushUpdate } from '../util/pushUpdate.js';

export interface PeriodResult {
  highest: number;
  lowest: number;
}

export class Period extends TechnicalIndicator<PeriodResult, number> {
  public values: number[];
  /** Highest return value during the current period. */
  #highest?: number;
  /** Lowest return value during the current period. */
  #lowest?: number;

  get highest() {
    return this.#highest;
  }

  get lowest() {
    return this.#lowest;
  }

  public readonly interval: number;

  constructor(interval: number) {
    super();
    this.interval = interval;
    this.values = [];
  }

  override getRequiredInputs() {
    return this.interval;
  }

  update(value: number, replace: boolean) {
    pushUpdate(this.values, replace, value, this.interval);

    if (this.values.length === this.interval) {
      this.#lowest = Math.min(...this.values);
      this.#highest = Math.max(...this.values);
      return (this.result = {
        highest: this.#highest,
        lowest: this.#lowest,
      });
    }

    return null;
  }
}
