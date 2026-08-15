import { Decimal } from '@app/money';
import type { Candle } from '@app/strategy-core';

// The latest Binance row is normally open, so a maximum-size request yields
// at most 999 closed source bars for the live computation.
export const TECHNICALS_KLINE_REQUEST_LIMIT = 1_000;
export const TECHNICALS_SOURCE_CANDLE_LIMIT = 999;
export const TECHNICALS_RATING_BAR_LIMIT = 250;

/** Match TradingView's traded-bar sequence, then retain the bounded rating tail. */
export const prepareTechnicalsRatingWindow = (candles: readonly Candle[]): Candle[] =>
  candles
    .slice(-TECHNICALS_SOURCE_CANDLE_LIMIT)
    .filter((candle) => !new Decimal(candle.volume).isZero())
    .slice(-TECHNICALS_RATING_BAR_LIMIT);
