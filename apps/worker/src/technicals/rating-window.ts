import { BINANCE_MAX_KLINE_LIMIT } from '@app/binance';
import { Decimal } from '@app/money';
import type { Candle } from '@app/strategy-core';

// Ask for the largest page Binance serves. The latest row in that page is normally still open, so a maximum-size request yields one fewer closed source bar than it returns.
export const TECHNICALS_KLINE_REQUEST_LIMIT: number = BINANCE_MAX_KLINE_LIMIT;
export const TECHNICALS_SOURCE_CANDLE_LIMIT: number = BINANCE_MAX_KLINE_LIMIT - 1;
export const TECHNICALS_RATING_BAR_LIMIT = 250;

/** Match TradingView's traded-bar sequence, then retain the bounded rating tail. */
export const prepareTechnicalsRatingWindow = (candles: readonly Candle[]): Candle[] =>
  candles
    .slice(-TECHNICALS_SOURCE_CANDLE_LIMIT)
    .filter((candle) => !new Decimal(candle.volume).isZero())
    .slice(-TECHNICALS_RATING_BAR_LIMIT);
