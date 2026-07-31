// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import { SMA } from '../../trend/SMA/SMA.js';
import type { HighLowClose } from '../../types/HighLowClose.js';
import { TechnicalIndicator, TradingSignal } from '../../types/Indicator.js';
import { pushUpdate } from '../../util/pushUpdate.js';

export interface StochasticResult {
  /** Slow stochastic indicator (%D) */
  stochD: number;
  /** Fast stochastic indicator (%K) */
  stochK: number;
}

/**
 * Stochastic Oscillator (STOCH)
 * Type: Momentum
 *
 * The Stochastic Oscillator was developed by George Lane and is range-bound between 0 and 100. The Stochastic
 * Oscillator attempts to predict price turning points. A value of 80 indicates that the asset is on the verge of being
 * overbought. By default, a Simple Moving Average (SMA) is used. When the momentum starts to slow down, the Stochastic
 * Oscillator values start to turn down. In the case of an uptrend, prices tend to make higher highs, and the
 * settlement price usually tends to be in the upper end of that time period's trading range.
 *
 * The stochastic k (%k) values represent the relation between current close to the period's price range (high/low). It
 * is sometimes referred as the "fast" stochastic period (fastk). The stochastic d (%d) values represent a Moving
 * Average of the %k values. It is sometimes referred as the "slow" period.
 *
 * @see https://en.wikipedia.org/wiki/Stochastic_oscillator
 * @see https://www.investopedia.com/terms/s/stochasticoscillator.asp
 * @see https://tulipindicators.org/stoch
 */
export class StochasticOscillator extends TechnicalIndicator<
  StochasticResult,
  HighLowClose<number>
> {
  public readonly candles: HighLowClose<number>[] = [];
  readonly #periodM: SMA;
  readonly #periodP: SMA;
  #previousResult?: StochasticResult;

  /**
   * @param n The %k period
   * @param m The %k slowing period
   * @param p The %d period
   */
  public n: number;
  public m: number;
  public p: number;

  constructor(n: number, m: number, p: number) {
    super();
    this.n = n;
    this.m = m;
    this.p = p;
    this.#periodM = new SMA(m);
    this.#periodP = new SMA(p);
  }

  override getRequiredInputs() {
    return this.n + this.p + 1;
  }

  update(candle: HighLowClose<number>, replace: boolean) {
    pushUpdate(this.candles, replace, candle, this.n);

    if (this.candles.length === this.n) {
      const highest = Math.max(...this.candles.map((candle) => candle.high));
      const lowest = Math.min(...this.candles.map((candle) => candle.low));
      const divisor = highest - lowest;
      let fastK = (candle.close - lowest) * 100;
      // Prevent division by zero
      fastK = fastK / (divisor === 0 ? 1 : divisor);
      const stochK = this.#periodM.update(fastK, replace); // (stoch_k, %k)
      const stochD = stochK && this.#periodP.update(stochK, replace); // (stoch_d, %d)

      if (stochK !== null && stochD !== null) {
        if (replace) {
          this.result = this.#previousResult;
        }

        this.#previousResult = this.result;

        return (this.result = {
          stochD,
          stochK,
        });
      }
    }

    return null;
  }

  protected calculateSignal(result?: StochasticResult | null | undefined) {
    const hasResult = result !== null && result !== undefined;
    const isOversold = hasResult && result.stochK <= 20;
    const isOverbought = hasResult && result.stochK >= 80;

    switch (true) {
      case !hasResult:
        return TradingSignal.UNKNOWN;
      case isOversold:
        return TradingSignal.BEARISH;
      case isOverbought:
        return TradingSignal.BULLISH;
      default:
        return TradingSignal.SIDEWAYS;
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
