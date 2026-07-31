// Market-trend computation. Pure, I/O-free helpers the cron wraps with the
// Binance fetches and the Redis write. Kept separate so the regime
// classification and breadth math are unit-tested without a network.

import { ema, sma, type CandleWindow } from '@app/indicators';
import type { MarketBreadth, MarketRegime, MarketTrendSymbol } from '@app/contracts';

/** 50-day SMA: the price-vs-trend line the regime reads. */
export const SMA_PERIOD = 50;
/** Fast/slow EMA cross confirming the SMA verdict (mirrors the momentum lens). */
const EMA_FAST = 10;
const EMA_SLOW = 150;
/**
 * Minimum daily candles to classify. The slow EMA is the longest lookback, so
 * a window shorter than this cannot produce a stable verdict — the symbol is
 * dropped rather than reported on a warming average.
 */
export const MIN_CANDLES: number = EMA_SLOW;

/** Quote asset the breadth universe is measured over. */
export const BREADTH_QUOTE = 'USDT';

/**
 * Classify one proxy symbol's daily regime from its closed-candle window.
 * `bull` = price above the 50-day SMA AND fast EMA above slow EMA; `bear` =
 * both the other way; `neutral` otherwise (the SMA and the EMA cross disagree).
 * Returns null when the window is too short to compute the slow EMA, so the
 * caller omits the symbol instead of reporting a misleading value.
 */
export const classifyTrend = (symbol: string, window: CandleWindow): MarketTrendSymbol | null => {
  if (window.length < MIN_CANDLES) return null;
  const lastClose = window[window.length - 1]?.close;
  if (lastClose === undefined) return null;

  const ma50 = sma(window, SMA_PERIOD);
  const emaFast = ema(window, EMA_FAST);
  const emaSlow = ema(window, EMA_SLOW);

  // Decimal comparison methods accept a decimal-string, so the close never
  // becomes a JS number — no IEEE-754 drift, no money-as-number.
  const aboveMa = ma50.lessThan(lastClose);
  const emaUp = emaFast.greaterThan(emaSlow);
  const regime: MarketRegime = aboveMa && emaUp ? 'bull' : !aboveMa && !emaUp ? 'bear' : 'neutral';

  return {
    symbol,
    price: lastClose as MarketTrendSymbol['price'],
    sma50: ma50.toString() as MarketTrendSymbol['sma50'],
    regime,
  };
};

/** One ticker row the breadth math reads. Structural subset of Ticker24hrDto.
 * `lastPrice` is optional: the breadth math never reads it, but the cron also
 * builds a per-symbol price map from the same tickers, and that reads it. */
export interface BreadthTicker {
  readonly symbol: string;
  readonly priceChangePercent: string;
  readonly lastPrice?: string;
}

/**
 * Universe breadth: the percent of `BREADTH_QUOTE` pairs that closed the 24h
 * window green. A display proxy for the same idea the discovery breadth gate
 * reads — not the gate itself, so the exact decimal handling need not match.
 * The sign test parses to number (a comparison against zero, not money
 * arithmetic) and is finiteness-guarded so a malformed row is excluded rather
 * than miscounted as down. Returns null on an empty universe (0/0 is
 * undefined and nothing could be added anyway).
 */
export const computeBreadth = (tickers: readonly BreadthTicker[]): MarketBreadth | null => {
  const universe = tickers.filter((t) => t.symbol.endsWith(BREADTH_QUOTE));
  const total = universe.length;
  if (total === 0) return null;
  let upCount = 0;
  for (const t of universe) {
    const n = Number(t.priceChangePercent);
    if (Number.isFinite(n) && n > 0) upCount += 1;
  }
  const percentUp = Math.round((upCount / total) * 1000) / 10;
  return { upCount, total, percentUp };
};
