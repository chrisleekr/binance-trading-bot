// @ts-nocheck — vendored MIT code; upstream uses looser strict-mode
/**
 * SPDX-License-Identifier: MIT
 * Ported from bennycode/trading-signals @ 537d859 (v7.4.3, 2026-05-19).
 * https://github.com/bennycode/trading-signals
 * © 2018-2026 Benny Neugebauer. Original MIT license retained.
 * No semantic edits; only this header prepended.
 */
import type { MovingAverage } from '../../trend/MA/MovingAverage.js';
import type { MovingAverageTypes } from '../../trend/MA/MovingAverageTypes.js';
import { SMA } from '../../trend/SMA/SMA.js';
import type { HighLow } from '../../types/HighLowClose.js';
import { TrendIndicatorSeries, TradingSignal } from '../../types/Indicator.js';

/**
 * Awesome Oscillator (AO)
 * Type: Momentum
 *
 * The Awesome Oscillator (AO) is an indicator used to measure market momentum.
 * It has been developed by the technical analyst and charting enthusiast Bill Williams.
 *
 * When AO crosses above Zero, short term momentum is rising faster than long term momentum which signals a bullish
 * buying opportunity.
 *
 * When AO crosses below Zero, short term momentum is falling faster then the long term momentum
 * which signals a bearish selling opportunity.
 *
 * @see https://www.tradingview.com/support/solutions/43000501826-awesome-oscillator-ao/
 * @see https://tradingstrategyguides.com/bill-williams-awesome-oscillator-strategy/
 */
export class AO extends TrendIndicatorSeries<HighLow<number>> {
  public readonly long: MovingAverage;
  public readonly short: MovingAverage;
  public readonly shortInterval: number;
  public readonly longInterval: number;

  constructor(
    shortInterval: number,
    longInterval: number,
    SmoothingIndicator: MovingAverageTypes = SMA,
  ) {
    super();
    this.shortInterval = shortInterval;
    this.longInterval = longInterval;
    this.short = new SmoothingIndicator(shortInterval);
    this.long = new SmoothingIndicator(longInterval);
  }

  override getRequiredInputs() {
    return this.long.getRequiredInputs();
  }

  update({ low, high }: HighLow<number>, replace: boolean) {
    const medianPrice = (low + high) / 2;

    this.short.update(medianPrice, replace);
    this.long.update(medianPrice, replace);

    if (this.long.isStable) {
      return this.setResult(this.short.getResultOrThrow() - this.long.getResultOrThrow(), replace);
    }

    return null;
  }

  protected calculateSignalState(result: number | null | undefined) {
    const hasResult = result !== null && result !== undefined;
    const isBullish = hasResult && result > 0;
    const isBearish = hasResult && result < 0;

    switch (true) {
      case !hasResult:
        return TradingSignal.UNKNOWN;
      case isBullish:
        return TradingSignal.BULLISH;
      case isBearish:
        return TradingSignal.BEARISH;
      default:
        return TradingSignal.SIDEWAYS;
    }
  }
}
