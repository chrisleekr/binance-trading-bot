import { z } from 'zod';

import { DecimalString } from './decimal.js';

// Market-trend snapshot. A global (non-profile) read of the broad tape the
// worker's `market-trend` cron computes once per cycle and the dashboard
// polls: BTC/ETH daily regime plus universe breadth. It is a CONTEXT
// indicator, not the per-symbol gate any strategy evaluates — the regime here
// is a market proxy (BTC/ETH) and breadth is the whole USDT universe.

/** Daily regime class for one proxy symbol. Mirrors the strategy vocabulary. */
export const MarketRegimeSchema = z.enum(['bull', 'bear', 'neutral']);
export type MarketRegime = z.infer<typeof MarketRegimeSchema>;

/**
 * One proxy symbol's daily trend. `regime` is `bull` when price is above the
 * 50-day SMA AND the fast EMA is above the slow EMA, `bear` when both are the
 * other way, else `neutral`. `price` and `sma50` are decimal-strings so the
 * web can render "% vs SMA50" without the server doing money-as-number math.
 */
export const MarketTrendSymbolSchema = z.object({
  symbol: z.string(),
  price: DecimalString,
  sma50: DecimalString,
  regime: MarketRegimeSchema,
});
export type MarketTrendSymbol = z.infer<typeof MarketTrendSymbolSchema>;

/**
 * Universe breadth: how much of the quote-asset universe is green on 24h.
 * `percentUp` is a count-derived ratio (0–100), not money, so it crosses the
 * wire as a number. This is the same signal the discovery breadth gate reads.
 */
export const MarketBreadthSchema = z.object({
  upCount: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  percentUp: z.number().min(0).max(100),
});
export type MarketBreadth = z.infer<typeof MarketBreadthSchema>;

export const MarketTrendSchema = z.object({
  computedAtMs: z.number().int().nonnegative(),
  symbols: z.array(MarketTrendSymbolSchema),
  breadth: MarketBreadthSchema,
});
/**
 * GET /market-trend response. `trend` is null only at cold start, before the
 * cron's first successful cycle writes a snapshot, so the UI shows a warming
 * state rather than a fetch error.
 */
export const MarketTrendResponseSchema = z.object({
  trend: MarketTrendSchema.nullable(),
});
export type MarketTrendResponse = z.infer<typeof MarketTrendResponseSchema>;
