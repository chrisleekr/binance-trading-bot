import { z } from 'zod';

/**
 * What strategies should do when the Technicals signal is older than
 * `useOnlyWithinMin`. `do-not-buy` is the safe default; old signals trading
 * stale market conditions are the high-severity failure mode this rule guards.
 */
/**
 * Hard cap on the number of Technicals intervals a single profile can watch.
 * The operator UI is built around scanning a small set of intervals at a
 * glance, and the strategy's gate ANDs across every row — more than ~3
 * quickly turns into a configuration the operator cannot reason about; the
 * cap also keeps the worker's Binance klines weight budget in check.
 */
export const MAX_TECHNICALS_INTERVALS = 3;

export const TechnicalsIfExpiresSchema = z.enum(['do-not-buy', 'allow-anyway']);
/**
 * One Technicals candle interval an operator wants the bot to watch. Up
 * to three intervals per symbol carry independent buy-allow and force-sell
 * toggles, so a fast interval can veto entries while a slow one only
 * contributes force-sell pressure. The five booleans
 * (`whenStrongBuy`/`whenBuy`/`whenNeutral`/`whenSell`/`whenStrongSell`) are
 * the operator's per-interval column toggles. `interval` is a free-form
 * string so the schema does not bake a strategy's allowed-interval enum
 * into the contracts layer; the strategy validates the value against its
 * `capabilities.candleIntervals`.
 */
export const TechnicalsIntervalConfigSchema = z.object({
  interval: z
    .string()
    .min(1)
    .describe(
      "Technicals candle interval to watch, e.g. '1m', '15m', '1h'. Must be one the strategy declares in its candleIntervals capabilities.",
    ),
  whenStrongBuy: z
    .boolean()
    .default(true)
    .describe(
      'Allow a buy when this interval reports STRONG_BUY. The buy gate ANDs across every configured interval whose allow-buy set is non-empty.',
    ),
  whenBuy: z
    .boolean()
    .default(true)
    .describe(
      'Allow a buy when this interval reports BUY. NEUTRAL always passes the buy gate; SELL/STRONG_SELL always veto.',
    ),
  whenSell: z
    .boolean()
    .default(false)
    .describe(
      'Trigger a Technicals force-sell when this interval reports SELL, while a position is held at profit and below its sell-trigger price. Disabled by default.',
    ),
  whenStrongSell: z
    .boolean()
    .default(false)
    .describe(
      'Trigger a Technicals force-sell when this interval reports STRONG_SELL, subject to the same profit + below-trigger guards as Sell. Disabled by default.',
    ),
  whenNeutral: z
    .boolean()
    .default(false)
    .describe(
      'Trigger a Technicals force-sell when this interval reports NEUTRAL. Almost always wrong; included for completeness.',
    ),
  mode: z
    .enum(['block', 'advisory'])
    .default('block')
    .describe(
      "Advisory rows never veto the buy gate; their verdict is still recorded in the audit log so dashboards can show 'would have vetoed'. Block keeps the AND-veto semantics. Default Block.",
    ),
});
/** TS type derived from {@link TechnicalsIntervalConfigSchema}. */
export type TechnicalsIntervalConfig = z.infer<typeof TechnicalsIntervalConfigSchema>;

/**
 * Per-interval Technicals compute outcome the worker's `technicals-compute`
 * cron writes to Redis after every batch commit. Operator visibility surface
 * for "is the compute job running" without scraping pino. The fields mirror
 * the counter buckets the cron already maintains so the dashboard never
 * lags the log. `error` is non-null when the batch failed outright; for a
 * partial batch `skippedErrored > 0` carries the count and `error` stays null.
 */
export const TechnicalsFetchStatusSchema = z.object({
  interval: z.string().min(1),
  fetchedAtMs: z.number().int().nonnegative(),
  requested: z.number().int().nonnegative(),
  written: z.number().int().nonnegative(),
  skippedErrored: z.number().int().nonnegative(),
  skippedInvalid: z.number().int().nonnegative(),
  latencyMs: z.number().int().nonnegative(),
  // Wall-clock (ms) of the most recent successful upstream commit for this
  // interval — i.e. the receipt's `fetchedAtMs` at the last call that
  // produced `written > 0`. Persisted across failed receipts so the operator
  // can read outage duration directly ("last fresh: 7m ago") without
  // correlating tick logs. `null` means the cron has never produced a
  // successful row since the worker booted.
  lastFreshAtMs: z.number().int().nonnegative().nullable().default(null),
  // Epoch-ms boundary of the most recent closed candle the cron has already
  // computed for this interval (`floor(now / intervalMs) * intervalMs`). The
  // candle-close gate skips the upstream fetch while this stays put: ratings
  // only change when a candle closes. `null` (missing/expired receipt) forces
  // a fetch — the self-heal path after a crash or a long idle gap.
  lastComputedCloseMs: z.number().int().nonnegative().nullable().default(null),
  error: z.string().nullable().default(null),
});
/** Parsed Technicals compute-job fetch outcome; one per interval the worker fetches. */
export type TechnicalsFetchStatus = z.infer<typeof TechnicalsFetchStatusSchema>;

/**
 * API response shape for `GET /api/technicals/health`. `intervals` is a
 * list of per-interval outcomes; empty means the cron has not committed
 * any fetch within the status-key TTL (operator should investigate).
 */
export const TechnicalsHealthResponseSchema = z.object({
  intervals: z.array(TechnicalsFetchStatusSchema),
});
/** Parsed health response. */
export type TechnicalsHealthResponse = z.infer<typeof TechnicalsHealthResponseSchema>;

/**
 * Operator-facing prose for the `intervals[]` field. Lifted to a constant so
 * the strategy-narrowed override (see `@app/strategy-trailing-trade`) reuses
 * one source instead of restating it. The widget hint prefix is prepended
 * per call site so the contract schema stays widget-agnostic.
 */
export const TECHNICALS_INTERVALS_DESCRIBE =
  'Technicals intervals to watch. Each row contributes its allow-buy set to the buy gate (ANDed across rows) and its trigger toggles to the force-sell branch. An empty list opens the gate fully — the strategy treats Technicals as opted out.';

/**
 * Reject an `intervals[]` array that lists the same interval twice. The
 * strategy's `technicals-gate` keys signals by interval name through a Map, so a
 * duplicate row's toggles would silently never participate in the gate
 * decision; the worker's `technicals-compute` cron would also issue
 * redundant lookups. Rejecting at parse keeps the failure visible to the
 * operator (422 on save) instead of silently dropping a row.
 */
export function intervalsUniquenessRefiner(
  rows: readonly { readonly interval: string }[],
  ctx: z.RefinementCtx,
): void {
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    const first = seen.get(row.interval);
    if (first !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'interval'],
        message: `duplicate interval — '${row.interval}' is already configured at row ${first + 1}`,
      });
      return;
    }
    seen.set(row.interval, i);
  });
}

/**
 * Per-symbol bundle config. `intervals[]` is the multi-interval surface:
 * the buy gate iterates every entry and the force-sell branch fires when any
 * entry's trigger toggle matches its signal. `useOnlyWithinMin` and
 * `ifExpires` stay global because freshness is a property of a signal, not
 * of an operator's intent. The safe default is one interval that vetoes
 * buys on SELL/STRONG_SELL but does not force-sell.
 */
export const TechnicalsBundleConfigSchema = z.object({
  useOnlyWithinMin: z
    .number()
    .int()
    .positive()
    .default(5)
    .describe(
      'Buy-gate freshness window in minutes. A Technicals signal older than this is treated as expired. Default 5 minutes, comfortably above the roughly 1-minute compute cadence plus tick jitter so a live signal is not treated as stale.',
    ),
  ifExpires: TechnicalsIfExpiresSchema.default('do-not-buy').describe(
    'What the buy side does on an expired signal. Do Not Buy is the safer default; Allow Anyway lets a stale signal still pass the gate.',
  ),
  // Hysteresis on the buy gate: how many CONSECUTIVE ticks the gate must read
  // ALLOW before a first buy is permitted. A count, not money, so `number` is
  // correct. 1 (default) permits on the first allow read — today's behaviour, so
  // the golden replay stays diff-0. Higher values require the signal to stay a
  // buy for that many ticks, so one flickering ALLOW does not open a position; a
  // single veto read resets the streak.
  entryConfirmReads: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe(
      'How many readings in a row the technical rating must stay a buy before the bot makes its first buy, so one brief flicker does not open a position. 1 buys on the first qualifying reading.',
    ),
  intervals: z
    .array(TechnicalsIntervalConfigSchema)
    .max(MAX_TECHNICALS_INTERVALS, {
      message: `up to ${MAX_TECHNICALS_INTERVALS} intervals — keeps the Binance klines weight budget in check. Add a strategy plugin if more are needed.`,
    })
    .superRefine(intervalsUniquenessRefiner)
    // Function-form default returns a fresh array per parse so a downstream
    // mutation never bleeds into the next parsed config.
    .default(() => [
      {
        interval: '1m',
        whenStrongBuy: true,
        whenBuy: true,
        whenSell: false,
        whenStrongSell: false,
        whenNeutral: false,
        mode: 'block' as const,
      },
    ])
    .describe(TECHNICALS_INTERVALS_DESCRIBE),
});
/** TS type derived from {@link TechnicalsBundleConfigSchema} so consumers don't re-run z.infer at every call site. */
export type TechnicalsBundleConfig = z.infer<typeof TechnicalsBundleConfigSchema>;

/**
 * The five-tier Technicals verdict. The summary verdict (`recommendation`)
 * is the strategy buy/sell gate; the moving-average and oscillator verdicts
 * are display-only context.
 */
export const TechnicalsRecommendationSchema = z.enum([
  'BUY',
  'SELL',
  'NEUTRAL',
  'STRONG_BUY',
  'STRONG_SELL',
]);
/** TS type derived from {@link TechnicalsRecommendationSchema}. */
export type TechnicalsRecommendation = z.infer<typeof TechnicalsRecommendationSchema>;

/** Nullable indicator cell — the upstream emits per-cell `null` when its data backend is cold. */
const indicator = () => z.number().nullable();

/**
 * Oscillator-group indicator readings — the same surface Technicals's own
 * technical-analysis "Oscillators" table shows. Every cell is nullable: a
 * partial upstream row must not fail validation.
 */
export const TechnicalsOscillatorsSchema = z.object({
  rsi: indicator(),
  stochK: indicator(),
  stochD: indicator(),
  cci20: indicator(),
  adx: indicator(),
  adxPlusDi: indicator(),
  adxMinusDi: indicator(),
  ao: indicator(),
  mom: indicator(),
  macdMacd: indicator(),
  macdSignal: indicator(),
  stochRsiK: indicator(),
  wr: indicator(),
  bbPower: indicator(),
  uo: indicator(),
});
/** TS type derived from {@link TechnicalsOscillatorsSchema}. */
export type TechnicalsOscillators = z.infer<typeof TechnicalsOscillatorsSchema>;

/**
 * Moving-average-group indicator readings — mirrors Technicals's "Moving
 * Averages" table. Every cell is nullable for the same reason as the
 * oscillator surface.
 */
export const TechnicalsMovingAveragesSchema = z.object({
  ema5: indicator(),
  ema10: indicator(),
  ema20: indicator(),
  ema30: indicator(),
  ema50: indicator(),
  ema100: indicator(),
  ema200: indicator(),
  sma5: indicator(),
  sma10: indicator(),
  sma20: indicator(),
  sma30: indicator(),
  sma50: indicator(),
  sma100: indicator(),
  sma200: indicator(),
  vwma: indicator(),
  hullMa9: indicator(),
  ichimokuBLine: indicator(),
});
/** TS type derived from {@link TechnicalsMovingAveragesSchema}. */
export type TechnicalsMovingAverages = z.infer<typeof TechnicalsMovingAveragesSchema>;

/** The two Technicals indicator groups bundled for the symbol-page panel. */
export const TechnicalsIndicatorsSchema = z.object({
  oscillators: TechnicalsOscillatorsSchema,
  movingAverages: TechnicalsMovingAveragesSchema,
});
/**
 * Latest Technicals technical-analysis verdict for a symbol. `receivedAtMs`
 * is millisecond-precision so freshness gating against `useOnlyWithinMin`
 * stays accurate at the 1-minute boundary. `recommendation` is the summary
 * verdict the strategy gate keys on; `maRecommendation` / `oscRecommendation`
 * and `indicators` are display-only context for the operator panel and are
 * nullable so a partial upstream row still produces a gating-valid signal.
 */
export const TechnicalsSignalSchema = z.object({
  symbol: z.string(),
  recommendation: TechnicalsRecommendationSchema,
  // The display-only fields default to `null` so a signal written before
  // this surface existed (or a strategy replay fixture) still parses.
  maRecommendation: TechnicalsRecommendationSchema.nullable().default(null),
  oscRecommendation: TechnicalsRecommendationSchema.nullable().default(null),
  receivedAtMs: z.number().int().nonnegative(),
  indicators: TechnicalsIndicatorsSchema.nullable().default(null),
});
/** TS type derived from {@link TechnicalsSignalSchema} so consumers don't re-run z.infer at every call site. */
export type TechnicalsSignal = z.infer<typeof TechnicalsSignalSchema>;

/**
 * One per-interval row in the bundle. `interval` mirrors the operator's
 * `intervals[i].interval` so the strategy can pair the live signal back to
 * its config row without an extra lookup. `signal` is null when the cron
 * has not yet cached a recommendation for this interval (boot, or a
 * newly-added interval).
 */
export const TechnicalsIntervalSignalSchema = z.object({
  interval: z.string().min(1),
  signal: TechnicalsSignalSchema.nullable(),
});
/** TS type derived from {@link TechnicalsIntervalSignalSchema}. */
export type TechnicalsIntervalSignal = z.infer<typeof TechnicalsIntervalSignalSchema>;

/**
 * Combined config + per-interval signals as one TickInput bundle. Bundling
 * keeps the tick input narrow and lets strategies treat "config but no
 * signal yet" as a first-class state per interval. `signals` is ordered to
 * match `config.intervals` 1:1 so the strategy can iterate the pair without
 * a Map lookup.
 */
export const TechnicalsBundleSchema = z
  .object({
    config: TechnicalsBundleConfigSchema,
    signals: z.array(TechnicalsIntervalSignalSchema),
  })
  // Enforce the documented 1:1 ordered pairing between `config.intervals`
  // and `signals` at the schema level. The worker's bundle-builder assembles
  // this shape untyped (`Record<string, unknown>`) for performance and skips
  // this parse; any consumer that does call `.parse()` (the strategy's own
  // bundleSchema at tick boundary, e.g.) gets a precise mismatch error
  // instead of a silent buy/force-sell pairing-bug.
  .superRefine((bundle, ctx) => {
    const expected = bundle.config.intervals.map((i) => i.interval);
    const actual = bundle.signals.map((s) => s.interval);
    if (expected.length !== actual.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signals'],
        message: 'signals must be 1:1 with config.intervals',
      });
      return;
    }
    for (let i = 0; i < expected.length; i += 1) {
      if (expected[i] !== actual[i]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['signals', i, 'interval'],
          message: `signals[${i}].interval must equal config.intervals[${i}].interval`,
        });
      }
    }
  });
/** TS type derived from {@link TechnicalsBundleSchema} so consumers don't re-run z.infer at every call site. */
export type TechnicalsBundle = z.infer<typeof TechnicalsBundleSchema>;

/**
 * Recommendations on an interval row that the operator has armed as buy-gate
 * passes. Empty when neither buy toggle is on (the row contributes nothing to
 * the buy gate and is skipped). A pure reader of the contract config, shared
 * by the strategy buy gate and the web display panel so a new buy toggle flows
 * to both in one edit instead of two hand-synced copies.
 */
export const allowBuySet = (
  row: TechnicalsIntervalConfig,
): ReadonlySet<TechnicalsRecommendation> => {
  const s = new Set<TechnicalsRecommendation>();
  if (row.whenStrongBuy) s.add('STRONG_BUY');
  if (row.whenBuy) s.add('BUY');
  return s;
};

/**
 * Recommendations on an interval row that the operator has armed as force-sell
 * triggers. Empty when none of the three sell toggles are on. Shared by the
 * strategy force-sell branch and the web display panel for the same single-edit
 * reason as {@link allowBuySet}.
 */
export const forceSellTriggers = (
  row: TechnicalsIntervalConfig,
): ReadonlySet<TechnicalsRecommendation> => {
  const s = new Set<TechnicalsRecommendation>();
  if (row.whenSell) s.add('SELL');
  if (row.whenStrongSell) s.add('STRONG_SELL');
  if (row.whenNeutral) s.add('NEUTRAL');
  return s;
};
