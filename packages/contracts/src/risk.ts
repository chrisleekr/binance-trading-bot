import { z } from 'zod';
import { decimalString, DecimalString } from './decimal.js';

/**
 * Profile-scoped risk controls, stored in the `profiles.risk_config` jsonb column
 * (NOT in the strategy config blob — enforcement is worker-side and cross-symbol,
 * which the pure per-(profile,symbol) strategy must not see, invariant #1).
 * Strategy-free, so it lives in `@app/contracts`.
 *
 * Three entry breakers live here, and every one of them only ever pauses NEW BUYS: open positions, their protective stops and their exits keep running, so a breaker can never lock in a loss at the worst moment. The daily-loss limit measures realised loss since 00:00 UTC and lifts at the next UTC midnight. The loss-streak guard counts losing closed cycles inside a rolling lookback, which is what catches a cluster of losses that straddles midnight and so is invisible to the daily limit. The drawdown guard measures realised peak-to-trough inside a rolling lookback, which is what catches a slide built from many small losses that never breaches a single day's limit. Both guards default OFF, so a stored config that predates them behaves exactly as it does today.
 * (A percent-of-equity limit is a planned follow-up; this ships fixed-quote
 * limits, which need no live-equity resolution.)
 */

// Re-parse the schema's own defaults so an absent block yields a fully-shaped
// object (mirrors discovery.ts and the strategy schemas' `withParsedDefault`).
const withParsedDefault = <T extends z.ZodTypeAny>(schema: T): z.ZodDefault<T> =>
  schema.default(() => schema.parse({}) as never);

/**
 * Which breaker paused new buys. One Redis key per kind and the key's existence is the whole signal, so no reader parses a payload to learn which breaker is active.
 *
 * The order is load-bearing: every surface that lists active breakers (the risk card, the health bar, the diagnosis labels) reports them in this order, so a shared order is the only way two surfaces cannot disagree about which breaker is named first.
 */
export const EntryHaltKind = z.enum(['daily-loss', 'loss-streak', 'drawdown']);
export type EntryHaltKind = z.infer<typeof EntryHaltKind>;

/**
 * The one operator-facing sentence per breaker for a buy it refused.
 *
 * Shared because two surfaces state it: the api's 409 on a BUY-side operator
 * action, and the worker's recorded rejection reason for an override whose
 * order the breaker dropped. Two hand-written sentences would drift, and the
 * operator would be told two different things about one breaker.
 */
export const ENTRY_HALT_REASONS: Readonly<Record<EntryHaltKind, string>> = {
  'daily-loss':
    "Today's loss limit has been reached, so new buys are paused until the next UTC day. Selling and cancelling still work.",
  'loss-streak':
    'Too many losing exits in a short window, so new buys are paused for the configured pause. Selling and cancelling still work.',
  drawdown:
    'Realised drawdown reached your limit, so new buys are paused for the configured pause. Selling and cancelling still work.',
};

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

// Both guards express every window in whole hours, bounded to a week. A window shorter than an hour would trip on ordinary intra-tick noise, and one longer than a week would keep punishing a profile for losses it has already traded out of.
const hours = (description: string, defaultHours: number) =>
  z.number().int().min(1).max(168).default(defaultHours).describe(description);

/** Enough losing closed cycles inside a rolling window pauses new buys for a fixed time. A COUNT over the window, not a consecutive run: a grid or a pyramid closes many small cycles, so one scratch win between two losses would reset a run-counter and leave the guard unarmable on exactly the strategy shapes it is for. Rolling, not calendar-day, so a cluster that straddles UTC midnight is still seen as one cluster. */
const LossStreakGuardSchema = z.object({
  maxLosingExits: z
    .number()
    .int()
    .min(0)
    .max(50)
    .default(0)
    .describe(
      'How many losing exits inside the lookback window pause new buys. 3 means the third loss in the window pauses buying. 0 turns this guard off.',
    ),
  lookbackHours: hours(
    'How far back to count losing exits, in hours. 24 looks at the last day regardless of the UTC midnight.',
    24,
  ),
  pauseHours: hours(
    'How long new buys stay paused once the guard trips, in hours. Selling and cancelling keep working.',
    24,
  ),
});

/** Realised peak-to-trough inside a rolling window pauses new buys for a fixed time. Catches a slide of many small losses that no single day's limit would ever see. */
const DrawdownGuardSchema = z.object({
  maxDrawdownQuote: decimalString('maxDrawdownQuote must be a non-negative decimal', { gte: 0 })
    .default('0')
    .describe(
      '@ui:price Deepest realised drawdown, in your quote currency (e.g. USDT), measured at the worst point inside the lookback window — the biggest fall from a peak to a later low anywhere in the window, not the fall as of right now. Once any such fall reaches this amount new buys pause, and recovering afterwards does not undo it while that fall is still inside the window. 0 turns this guard off.',
    ),
  lookbackHours: hours(
    'How far back the bot looks for a fall, in hours. 72 searches the last three days. Each fall is measured from whatever the running high was just before it, so an earlier fall still counts even after a later, higher peak.',
    72,
  ),
  pauseHours: hours(
    'How long new buys stay paused once the guard trips, in hours. Selling and cancelling keep working.',
    24,
  ),
});

export const RiskConfigSchema = withParsedDefault(
  z.object({
    dailyLossLimitQuote: decimalString('dailyLossLimitQuote must be a non-negative decimal', {
      gte: 0,
    })
      .default('0')
      .describe(
        '@ui:price Most realised loss, in your quote currency (e.g. USDT), you will accept in one UTC day. When today’s realised loss reaches this, the bot stops opening or adding to positions until the next UTC day; open positions and their stops keep running. 0 turns the breaker off.',
      ),
    // Each guard is wrapped in its own `withParsedDefault` because the helper above is a shallow default, not a deep merge: an unwrapped nested object would be absent entirely from a stored `{dailyLossLimitQuote:'9'}` row, and the worker reads this column through `safeParse` on every cron cycle.
    lossStreak: withParsedDefault(LossStreakGuardSchema),
    drawdown: withParsedDefault(DrawdownGuardSchema),
  }),
);
export type StoredRiskConfig = z.infer<typeof RiskConfigSchema>;

/**
 * Live breaker state for the risk status card. `halted` reflects the worker's
 * Redis entry-halt flags; `todayRealizedPnl` is the profile's realised P/L since
 * 00:00 UTC (negative = a loss); `limitQuote` is the configured daily loss limit
 * (null when that breaker is off); `resetsAtMs` is when buying resumes.
 */
export const RiskStatus = z.object({
  halted: z.boolean(),
  /** Every breaker currently pausing buys, in `EntryHaltKind` order; empty when `halted` is false. */
  haltKinds: z.array(EntryHaltKind),
  todayRealizedPnl: DecimalString,
  limitQuote: DecimalString.nullable(),
  /** Epoch ms at which the LAST active halt lifts (daily: next UTC midnight; guards: the key's remaining TTL), because that is when buying actually resumes. Null when not halted. */
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
