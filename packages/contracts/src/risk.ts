import { z } from 'zod';
import { decimalString, DecimalString } from './decimal.js';

/**
 * Profile-scoped risk controls, stored in the `profiles.risk_config` jsonb column
 * (NOT in the strategy config blob — enforcement is worker-side and cross-symbol,
 * which the pure per-(profile,symbol) strategy must not see, invariant #1).
 * Strategy-free, so it lives in `@app/contracts`.
 *
 * Today this is the daily-loss circuit breaker: once a profile's realised loss for
 * the current UTC day reaches `dailyLossLimitQuote`, the worker pauses new BUYs for
 * the rest of the day. Open positions and their protective stops/exits stay live —
 * the breaker never force-sells, so it cannot lock in a loss at the worst moment.
 * (A percent-of-equity limit is a planned follow-up; this ships the fixed-quote
 * limit, which needs no live-equity resolution.)
 */

// Re-parse the schema's own defaults so an absent block yields a fully-shaped
// object (mirrors discovery.ts and the strategy schemas' `withParsedDefault`).
const withParsedDefault = <T extends z.ZodTypeAny>(schema: T): z.ZodDefault<T> =>
  schema.default(() => schema.parse({}) as never);

/**
 * The one operator-facing sentence for a buy the daily-loss breaker refused.
 *
 * Shared because two surfaces state it: the api's 409 on a BUY-side operator
 * action, and the worker's recorded rejection reason for an override whose
 * order the breaker dropped. Two hand-written sentences would drift, and the
 * operator would be told two different things about one breaker.
 */
export const DAILY_ENTRY_HALT_REASON =
  "Today's loss limit has been reached, so new buys are paused until the next UTC day. Selling and cancelling still work.";

/** Start of the current UTC day (00:00:00.000 UTC) for `nowMs`, in epoch ms. */
export const startOfUtcDayMs = (nowMs: number): number => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** Next UTC midnight after `nowMs`, in epoch ms — when a daily halt lifts. */
export const nextUtcMidnightMs = (nowMs: number): number => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

export const RiskConfigSchema = withParsedDefault(
  z.object({
    dailyLossLimitQuote: decimalString('dailyLossLimitQuote must be a non-negative decimal', {
      gte: 0,
    })
      .default('0')
      .describe(
        '@ui:price Most realised loss, in your quote currency (e.g. USDT), you will accept in one UTC day. When today’s realised loss reaches this, the bot stops opening or adding to positions until the next UTC day; open positions and their stops keep running. 0 turns the breaker off.',
      ),
  }),
);
export type StoredRiskConfig = z.infer<typeof RiskConfigSchema>;

/**
 * Live breaker state for the risk status card. `halted` reflects the worker's
 * Redis entry-halt flag; `todayRealizedPnl` is the profile's realised P/L since
 * 00:00 UTC (negative = a loss); `limitQuote` is the configured loss limit (null
 * when the breaker is off); `resetsAtMs` is the next UTC midnight when a halt
 * lifts (null when not halted).
 */
export const RiskStatus = z.object({
  halted: z.boolean(),
  todayRealizedPnl: DecimalString,
  limitQuote: DecimalString.nullable(),
  resetsAtMs: z.number().int().nullable(),
});
export type RiskStatus = z.infer<typeof RiskStatus>;

/**
 * GET /profiles/:id/risk payload: the stored config (safe defaults + `configInvalid`
 * when a stored value fails validation, mirroring discovery) plus the live status.
 */
export const RiskDashboardResponse = z.object({
  config: RiskConfigSchema,
  configInvalid: z.boolean(),
  quoteAsset: z.string(),
  status: RiskStatus,
});
export type RiskDashboardResponse = z.infer<typeof RiskDashboardResponse>;
