// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import type { DEMA } from '../../trend/DEMA/DEMA.js';
import type { EMA } from '../../trend/EMA/EMA.js';
import { TechnicalIndicator, TradingSignal } from '../../types/Indicator.js';
import { pushUpdate } from '../../util/pushUpdate.js';

export type MACDResult = {
  histogram: number;
  macd: number;
  signal: number;
};

/**
 * Moving Average Convergence Divergence (MACD)
 * Type: Momentum
 *
 * The MACD triggers trading signals when it crosses above (bullish buying opportunity) or below (bearish selling
 * opportunity) its signal line. MACD can be used together with the RSI to provide a more accurate trading signal.
 *
 * @see https://www.investopedia.com/terms/m/macd.asp
 */
export class MACD extends TechnicalIndicator<MACDResult, number> {
  public readonly prices: number[] = [];
  #previousResult?: MACDResult;

  public readonly short: EMA | DEMA;
  public readonly long: EMA | DEMA;
  public readonly signal: EMA | DEMA;

  constructor(short: EMA | DEMA, long: EMA | DEMA, signal: EMA | DEMA) {
    super();
    this.short = short;
    this.long = long;
    this.signal = signal;
  }

  override getRequiredInputs() {
    return this.long.getRequiredInputs();
  }

  update(price: number, replace: boolean) {
    pushUpdate(this.prices, replace, price, this.long.interval);

    const short = this.short.update(price, replace);
    const long = this.long.update(price, replace);

    if (this.prices.length === this.long.interval) {
      const macd = short - long;
      const signal = this.signal.update(macd, replace);

      if (replace) {
        this.result = this.#previousResult;
      }

      this.#previousResult = this.result;

      return (this.result = {
        histogram: macd - signal,
        macd,
        signal,
      });
    }
    return null;
  }

  protected calculateSignal(result?: MACDResult | null | undefined) {
    const hasResult = result !== null && result !== undefined;
    const isBullish = hasResult && result.histogram > 0; // MACD above signal line
    const isBearish = hasResult && result.histogram < 0; // MACD below signal line

    switch (true) {
      case !hasResult:
        return TradingSignal.UNKNOWN;
      case isBullish:
        return TradingSignal.BULLISH;
      case isBearish:
      default:
        return TradingSignal.BEARISH;
    }
  }

  getSignal(): {
    state: (typeof TradingSignal)[keyof typeof TradingSignal];
    hasChanged: boolean;
  } {
    const previousState = this.calculateSignal(this.#previousResult);
    const state = this.calculateSignal(this.getResult());
    const hasChanged = previousState !== state;

    return {
      hasChanged,
      state,
    };
  }
}
