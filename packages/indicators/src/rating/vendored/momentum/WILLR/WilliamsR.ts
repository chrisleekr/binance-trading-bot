// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { TradingSignal, TrendIndicatorSeries } from '../../types/Indicator.js';
import type { HighLowClose } from '../../types/HighLowClose.js';
import { pushUpdate } from '../../util/pushUpdate.js';

/**
 * Williams %R (Williams Percent Range)
 * Type: Momentum
 *
 * The Williams %R indicator, developed by Larry Williams, is a momentum indicator that measures overbought
 * and oversold levels. It is similar to the Stochastic Oscillator but is plotted on an inverted scale,
 * ranging from 0 to -100. Readings from 0 to -20 are considered overbought, while readings from -80 to -100
 * are considered oversold.
 *
 * The Williams %R is arithmetically exactly equivalent to the %K stochastic oscillator, mirrored at the 0%-line.
 *
 * Formula: %R = (Highest High - Close) / (Highest High - Lowest Low) × -100
 *
 * @see https://en.wikipedia.org/wiki/Williams_%25R
 * @see https://www.investopedia.com/terms/w/williamsr.asp
 */
export class WilliamsR extends TrendIndicatorSeries<HighLowClose<number>> {
  public readonly candles: HighLowClose<number>[] = [];

  public readonly interval: number;

  constructor(interval: number) {
    super();
    this.interval = interval;
  }

  override getRequiredInputs() {
    return this.interval;
  }

  override update(candle: HighLowClose<number>, replace: boolean) {
    pushUpdate(this.candles, replace, candle, this.interval);

    if (this.candles.length === this.interval) {
      let highest = this.candles[0].high;
      let lowest = this.candles[0].low;

      for (let i = 1; i < this.candles.length; i++) {
        if (this.candles[i].high > highest) {
          highest = this.candles[i].high;
        }

        if (this.candles[i].low < lowest) {
          lowest = this.candles[i].low;
        }
      }

      const divisor = highest - lowest;

      if (divisor === 0) {
        return this.setResult(-100, replace);
      }

      const willR = ((highest - candle.close) / divisor) * -100;
      return this.setResult(willR, replace);
    }

    return null;
  }

  protected calculateSignalState(result?: number | null | undefined) {
    const hasResult = result !== null && result !== undefined;
    const isOverbought = hasResult && result >= -20;
    const isOversold = hasResult && result <= -80;

    switch (true) {
      case !hasResult:
        return TradingSignal.UNKNOWN;
      case isOverbought:
        return TradingSignal.BULLISH;
      case isOversold:
        return TradingSignal.BEARISH;
      default:
        return TradingSignal.SIDEWAYS;
    }
  }
}
