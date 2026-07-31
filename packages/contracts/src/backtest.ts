import { z } from 'zod';
import { SaveDiagnostics } from './config-lint.js';
import { DecimalString, PositiveDecimalString } from './decimal.js';
import { MarketRegimeSchema } from './market-trend.js';
import { BACKTEST_INTERVALS } from './kline-intervals.js';

// The zod schema + inferred type live here, alongside the params validator that
// uses them, deriving off the single-sourced tuple in `./kline-intervals.js` so
// the two cannot drift. The tuple reaches the package root via that module's own
// barrel export, so it is not re-exported here.
export const BacktestInterval = z.enum(BACKTEST_INTERVALS);
export type BacktestInterval = z.infer<typeof BacktestInterval>;

const intervalRank = (interval: BacktestInterval): number => BACKTEST_INTERVALS.indexOf(interval);

/**
 * Request to launch a backtest for a profile. `strategyConfigOverride` is
 * opaque at the contract layer (validated server-side against the strategy's
 * own override schema) so contracts stays a leaf with no strategy dependency.
 */
// Bounds on a backtest request so a single malformed call cannot enqueue an
// unbounded backfill. A basket of 50 symbols is far above any real run, and a
// 5-year span bounds the per-symbol bar count — both generous for legitimate
// use, both fatal to the pathological `symbols:[...5000]` / `toMs: 9e15`. These
// cap each axis, not their product: the worst legitimate-shape request
// (50 symbols × 5y × 1m) is still large, accepted as a single-operator risk (the
// route is behind per-profile ownership; see docs/architecture/backtesting.md).
const MAX_BACKTEST_SYMBOLS = 50;
const MAX_BACKTEST_SPAN_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export const BacktestParamsSchema = z
  .object({
    symbols: z.array(z.string().min(1)).min(1).max(MAX_BACKTEST_SYMBOLS),
    fromMs: z.number().int().nonnegative(),
    toMs: z.number().int().nonnegative(),
    strategyInterval: BacktestInterval,
    detailInterval: BacktestInterval,
    initialQuoteBalance: PositiveDecimalString,
    fees: z.object({
      makerBps: z.number().nonnegative(),
      takerBps: z.number().nonnegative(),
    }),
    slippageBps: z.number().nonnegative(),
    // Half the bid/ask spread, in bps, charged on EVERY fill (including LIMIT):
    // a backtested "limit at X" assumes perfect queue priority and no adverse
    // selection, which live execution does not give. Applied as a half-spread
    // haircut (BUY pays up, SELL receives less) on top of slippage for market /
    // stop fills. `nullish`, not just `optional`: absent and null both mean no
    // spread, so the fill model treats them as 0 and a run persisted before this
    // field shipped reproduces byte-for-byte.
    spreadBps: z.number().nonnegative().nullish(),
    // Volume-participation cap: a single fill may take at most this percentage
    // of the filling bar's base volume; the remainder rests and works across
    // later bars. Models that a large order cannot clear at one price on a thin
    // bar. `nullish` = disabled (no cap), keeping small orders and existing runs
    // unchanged; the operator opts into the realism from the form.
    volumeCapPct: z.number().positive().max(100).nullish(),
    // `nullish`, not just `optional`: "no override" is equivalent to absent, and
    // a stored row that serialised it as JSON `null` means the same. Downstream
    // already normalises via `?? {}`.
    strategyConfigOverride: z.record(z.string(), z.unknown()).nullish(),
    // When true, every backtested symbol is treated as discovery-managed for the
    // whole window: entries are marked `discoveryEntry`, so exits go through the
    // trail / hard-stop / time-stop only and the technicals force-sell is
    // skipped — matching the live discovery-entry exit regime so a backtest of
    // discovery picks does not diverge from live. Simplification: discovery
    // ADD/REAP over time is NOT modelled — a symbol stays managed once entered,
    // so this is slightly optimistic versus live, where a reap could drop a
    // symbol mid-window. Requires a configured `sell.stopLossPercentage`: a
    // discovery entry is fail-closed without a hard stop (`discovery-no-stop`),
    // so a run with no stop reports zero trades. Default false keeps the plain
    // grid path byte-identical.
    discoveryMode: z.boolean().default(false),
    // The run a Re-run forked from (the anchored run whose config the Draft was
    // launched against). Carried on the request so the new run records its
    // comparison lineage. The API validates ownership before persisting it; a
    // non-owned id is dropped to null, never an error. Nullish: absent and null
    // both mean "no parent" (a fresh, standalone run).
    parentRunId: z.uuid().nullish(),
  })
  .refine((p) => p.fromMs < p.toMs, {
    message: 'fromMs must be before toMs',
    path: ['fromMs'],
  })
  .refine((p) => p.toMs - p.fromMs <= MAX_BACKTEST_SPAN_MS, {
    message: 'backtest window must not exceed 5 years',
    path: ['toMs'],
  })
  .refine((p) => intervalRank(p.detailInterval) <= intervalRank(p.strategyInterval), {
    message: 'detailInterval must be finer than or equal to strategyInterval',
    path: ['detailInterval'],
  });
export type BacktestParams = z.infer<typeof BacktestParamsSchema>;

/**
 * Project a backtest request onto the dimensions that define what it traded and
 * how fills were modelled, flattened and normalised into ONE object. This is
 * the single enumeration of the market dims: `sameMarket` compares it and the
 * ledger's backtest signature hashes it, so a new dim is added here and nowhere
 * else. Symbols are sorted because a basket is a set.
 * `spreadBps`/`volumeCapPct` collapse absent and null to null (both mean "not
 * set"), so a legacy run that serialised them as absent keys the same as one
 * that sent null. `initialQuoteBalance` stays a decimal-string: it is money,
 * never coerced.
 */
export function marketOf(params: BacktestParams) {
  return {
    symbols: [...params.symbols].sort(),
    fromMs: params.fromMs,
    toMs: params.toMs,
    strategyInterval: params.strategyInterval,
    detailInterval: params.detailInterval,
    makerBps: params.fees.makerBps,
    takerBps: params.fees.takerBps,
    slippageBps: params.slippageBps,
    spreadBps: params.spreadBps ?? null,
    volumeCapPct: params.volumeCapPct ?? null,
    discoveryMode: params.discoveryMode,
    initialQuoteBalance: params.initialQuoteBalance,
  };
}

/**
 * Whether two backtests ran the SAME market window: equal on every dimension
 * that defines what was traded and how fills were modelled. Two runs that are
 * `sameMarket` are comparable — their return, alpha, and drawdown measure the
 * same underlying conditions, so a delta between them reflects the strategy
 * change, not a different world. A run differing on any one dim is not
 * comparable. `strategyConfigOverride` is deliberately NOT a market dim:
 * changing the config is exactly the A/B the comparison exists to measure.
 * Both sides normalise through {@link marketOf}, so symbol order and
 * absent-vs-null fill knobs do not create a false difference.
 */
export function sameMarket(a: BacktestParams, b: BacktestParams): boolean {
  return JSON.stringify(marketOf(a)) === JSON.stringify(marketOf(b));
}

// 'cancelled' is terminal and distinct from 'error': the operator can abort a
// running backtest so the worker stops computing a result no longer needed. The
// worker polls for this status mid-run.
export const BacktestStatus = z.enum(['queued', 'running', 'done', 'error', 'cancelled']);
export type BacktestStatus = z.infer<typeof BacktestStatus>;

// Default page size for the past-runs list, shared so the API's query default
// and the web client's "omit `limit` at the default" optimisation cannot drift.
// Small for the mobile-first runs table; the web selector offers larger sizes.
export const BACKTEST_LIST_DEFAULT_PAGE_SIZE = 10;

// Past-runs table filter. Outcome-oriented, not raw status: `profit`/`loss` are
// done runs split by total-return sign (what an operator reviewing backtests
// actually wants), `error` is failed runs. Absent means every run.
export const BacktestRunListFilter = z.enum(['profit', 'loss', 'error']);
export type BacktestRunListFilter = z.infer<typeof BacktestRunListFilter>;

/**
 * Coarse phase of a running backtest. `backfill` loads price history, `warmup`
 * feeds the indicator warm-up window (no trades yet), `replay` is the strategy
 * tick loop, `finalize` computes metrics. The phase label lets the UI explain a
 * bar that sits near 0 during a long warm-up instead of reading as wedged (#334).
 */
export const BacktestPhase = z.enum(['backfill', 'warmup', 'replay', 'finalize']);
export type BacktestPhase = z.infer<typeof BacktestPhase>;

/**
 * Qualitative progress context for a running run. The numeric `pct` lives in the
 * integer `progress` column; this carries the phase, the replay tick counts
 * (`processed`/`total`, set only in `replay`), and the symbol currently loading
 * (`backfill`). Persisted on the row so a fresh page load shows the last phase
 * before the first live WS frame arrives.
 */
export const BacktestProgressDetailSchema = z.object({
  phase: BacktestPhase,
  processed: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  symbol: z.string().optional(),
});
export type BacktestProgressDetail = z.infer<typeof BacktestProgressDetailSchema>;

/** Status of a run, polled by the UI while it executes. */
export const BacktestRunStatusSchema = z.object({
  runId: z.uuid(),
  profileId: z.uuid(),
  status: BacktestStatus,
  progress: z.number().int().min(0).max(100),
  // Absent on a queued run (or a row predating the column); present once the
  // worker writes the first phase. The API always emits it (null or value).
  progressDetail: BacktestProgressDetailSchema.nullish(),
  error: z.string().nullable().optional(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable().optional(),
  finishedAt: z.iso.datetime().nullable().optional(),
});
/** One point on the equity curve, denominated in the quote asset. */
export const EquityPointSchema = z.object({
  tsMs: z.number().int(),
  equity: DecimalString,
});
export type EquityPoint = z.infer<typeof EquityPointSchema>;

/** One point on the underwater (drawdown) curve; `ddPct` is <= 0. */
export const DrawdownPointSchema = z.object({
  tsMs: z.number().int(),
  ddPct: z.number(),
});
export type DrawdownPoint = z.infer<typeof DrawdownPointSchema>;

/** A single simulated execution. Money fields are decimal-strings. */
export const BacktestTradeSchema = z.object({
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  reason: z.string(),
  price: DecimalString,
  qty: DecimalString,
  feeQuote: DecimalString,
  tsMs: z.number().int(),
});
export type BacktestTrade = z.infer<typeof BacktestTradeSchema>;

/**
 * Headline metrics. Money amounts (balances, profit, per-trade P&L) are
 * decimal-strings; unitless statistics (ratios) and percentages are numbers,
 * matching the engine which computes them as `number` off Decimal series.
 */
export const BacktestMetricsSchema = z.object({
  // Returns
  startingBalance: DecimalString,
  finalBalance: DecimalString,
  absoluteProfit: DecimalString,
  totalReturnPct: z.number(),
  cagrPct: z.number(),
  marketChangePct: z.number(),
  dcaChangePct: z.number(),
  // Alpha = strategy return minus the passive benchmark over the same range.
  // Negative alpha with a positive total return means the strategy lost to
  // simply holding (or averaging into) the basket.
  alphaVsHoldPct: z.number(),
  alphaVsDcaPct: z.number(),
  // Risk-adjusted. sharpe/sortino are raw per-closed-trade ratios (not
  // annualized, so they stay meaningful for short backtests); calmar is
  // CAGR / |max drawdown|; sqn is the System Quality Number. sharpe/sortino/sqn
  // are `null` — undefined, not 0 — when there are too few trades to trust the
  // ratio or the denominator is zero (zero variance, or zero downside for
  // Sortino). Consumers must render null as "n/a", not as a numeric 0.
  sharpe: z.number().nullable(),
  sortino: z.number().nullable(),
  calmar: z.number(),
  sqn: z.number().nullable(),
  // Drawdown
  maxDrawdownPct: z.number(),
  absoluteDrawdown: DecimalString,
  drawdownStartMs: z.number().int().nullable(),
  drawdownEndMs: z.number().int().nullable(),
  // Trade quality
  totalTrades: z.number().int().nonnegative(),
  winRate: z.number(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  profitFactor: z.number().nullable(),
  expectancy: DecimalString,
  bestTradePct: z.number().nullable(),
  worstTradePct: z.number().nullable(),
  avgTradePnl: DecimalString,
  avgTradeDurationMs: z.number().int().nonnegative().nullable(),
});
export type BacktestMetrics = z.infer<typeof BacktestMetricsSchema>;

/** A trade-or-hold verdict for a finished backtest: should this config trade live at all? */
export interface TradeOrHoldRecommendation {
  readonly recommend: 'trade' | 'hold';
  readonly reason: string;
}

/**
 * The honest "is this worth running at all?" verdict. The strategy's return is
 * net of its own trading fees; the hold benchmark is FEE-FREE (a pure price
 * change), so `alphaVsHoldPct` is a conservative comparison — the strategy had
 * to overcome its fees to beat a benchmark that paid none. A strategy that still
 * LOST to that fee-free buy-and-hold (`alphaVsHoldPct < 0`) has no edge to deploy
 * — holding the basket would have beaten it with zero fees and zero operational
 * risk, so the
 * recommendation is to HOLD, not trade. The boundary matches the live-enablement
 * gate's alpha floor (`alphaVsHoldPct >= minAlphaVsHoldPct`, default 0): a config
 * that exactly matches holding (alpha 0) clears the gate, so the banner stays
 * silent there too — the two surfaces agree at the boundary. Surfacing this makes
 * the "just hold" answer explicit instead of leaving the operator to infer it from
 * a negative alpha cell. Pure so the web banner and any caller agree.
 *
 * A run with zero completed trades is handled first: it has no edge to evaluate
 * at all (the strategy never closed a round-trip), so its `alphaVsHoldPct` is an
 * artifact of cash sitting out the market's move, not a result the config can
 * repeat. Such a run must never read as "trade" (#534).
 */
export function recommendTradeOrHold(metrics: {
  readonly alphaVsHoldPct: number;
  readonly totalTrades: number;
}): TradeOrHoldRecommendation {
  if (metrics.totalTrades === 0) {
    return {
      recommend: 'hold',
      reason: `This run completed no trades, so there is no edge to evaluate — any apparent alpha is just cash sitting out the market's move, not a result this config can repeat live.`,
    };
  }
  if (metrics.alphaVsHoldPct < 0) {
    return {
      recommend: 'hold',
      reason: `Holding the basket would have beaten this strategy by ${Math.abs(metrics.alphaVsHoldPct).toFixed(2)}% — and holding pays no fees and carries no operational risk — so trading this config live is unlikely to add value.`,
    };
  }
  return {
    recommend: 'trade',
    reason: `Beat a fee-free buy-and-hold by ${metrics.alphaVsHoldPct.toFixed(2)}%, after covering this strategy's own trading fees.`,
  };
}

/** Per-symbol breakdown for a portfolio run. */
export const BacktestPerSymbolSchema = z.object({
  symbol: z.string(),
  tradeCount: z.number().int().nonnegative(),
  pnlQuote: DecimalString,
});
export type BacktestPerSymbol = z.infer<typeof BacktestPerSymbolSchema>;

/**
 * One realised round-trip: a reducing SELL paired against the average cost of the
 * position it closed (average-cost accounting, so a grid that stacks several buys
 * before one sell yields one round-trip per reducing sell). The headline trade
 * metrics (win rate, profit factor, expectancy) are reduced from these; surfaced
 * raw so the UI can show a trade table, P&L / holding-time distributions, and
 * exit-reason attribution. `returnPct` is P&L over the closed portion's cost basis;
 * `feeQuote` is the buy fees attributed to the closed lot plus the closing sell fee.
 */
export const BacktestRoundTripSchema = z.object({
  symbol: z.string(),
  entryPrice: DecimalString,
  exitPrice: DecimalString,
  qty: DecimalString,
  pnlQuote: DecimalString,
  returnPct: z.number(),
  feeQuote: DecimalString,
  openTsMs: z.number().int(),
  closeTsMs: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  exitReason: z.string(),
});
export type BacktestRoundTrip = z.infer<typeof BacktestRoundTripSchema>;

/**
 * Performance attributed to one market regime (benchmark symbol's daily close
 * vs its 50-day average). `alphaVsHoldPct` is the strategy's return minus
 * buy-and-hold over the SAME regime steps: a long-only strategy positive only in
 * `bull` and flat/negative elsewhere is holding with extra steps, not edge. The
 * regime vocabulary is shared with the live Market Trend card ({@link
 * MarketRegimeSchema}).
 */
export const RegimeSegmentSchema = z.object({
  regime: MarketRegimeSchema,
  returnPct: z.number(),
  holdReturnPct: z.number(),
  alphaVsHoldPct: z.number(),
  trades: z.number().int().nonnegative(),
  winRate: z.number(),
  profitFactor: z.number().nullable(),
  expectancy: DecimalString,
});
export type RegimeSegment = z.infer<typeof RegimeSegmentSchema>;

/**
 * Metrics recomputed over only the most-recent `fraction` of a run's time span
 * (the holdout). An operator tunes a config against the full window, so its
 * metrics are in-sample and can be curve-fit; this slice the tuning never
 * targeted is the honest test set. `alphaVsHoldPct` here clearing the same bar as
 * the full run is the honest defence against a config that only looks good
 * in-sample. Surfaced on the backtest results page, and the live-enablement gate
 * can require it to clear the same bar (`EnablementPolicy.requireOutOfSample`).
 */
export const OutOfSampleSegmentSchema = z.object({
  fraction: z.number(),
  fromMs: z.number().int(),
  toMs: z.number().int(),
  returnPct: z.number(),
  holdReturnPct: z.number(),
  alphaVsHoldPct: z.number(),
  trades: z.number().int().nonnegative(),
  winRate: z.number(),
  profitFactor: z.number().nullable(),
  expectancy: DecimalString,
});
export type OutOfSampleSegment = z.infer<typeof OutOfSampleSegmentSchema>;

/**
 * One aggregated strategy-metric bucket over a run: a counter keyed by metric
 * name and tags. The engine sums emissions without interpreting them, so any
 * strategy's counters roll up (e.g. TT's `tt_grid_buy_emit`, or
 * `tt_first_buy_skipped` split by its `reason` tag).
 */
export const DecisionBreakdownMetricSchema = z.object({
  name: z.string(),
  tags: z.record(z.string(), z.string()),
  count: z.number().int().nonnegative(),
});
export type DecisionBreakdownMetric = z.infer<typeof DecisionBreakdownMetricSchema>;

/**
 * One aggregated strategy-log bucket over a run, keyed by level, message, and
 * the `reason` context field. The buy gate reports its vetoes on this channel
 * (`tt-technicals-gate-veto` / `tt-indicator-gate-veto` carry `context.reason`),
 * so this surfaces "why a buy was vetoed" without a dedicated metric.
 */
export const DecisionBreakdownLogSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
  reason: z.string().nullable(),
  count: z.number().int().nonnegative(),
});
export type DecisionBreakdownLog = z.infer<typeof DecisionBreakdownLogSchema>;

/**
 * Behavioural "why" summary for a run: the strategy's per-tick metric and log
 * emissions, aggregated. Answers "why did it trade, or not": buys emitted,
 * skips by reason, gate vetoes by reason, which the equity curve cannot.
 */
export const DecisionBreakdownSchema = z.object({
  metrics: z.array(DecisionBreakdownMetricSchema),
  logs: z.array(DecisionBreakdownLogSchema),
});
export type DecisionBreakdown = z.infer<typeof DecisionBreakdownSchema>;

/** Full result, embedded in the status response once `status === 'done'`. */
export const BacktestResultSchema = z.object({
  params: BacktestParamsSchema,
  metrics: BacktestMetricsSchema,
  equityCurve: z.array(EquityPointSchema),
  drawdownSeries: z.array(DrawdownPointSchema),
  trades: z.array(BacktestTradeSchema),
  // Realised round-trips (one per reducing sell). Factory-defaulted so runs
  // persisted before this field shipped still parse — their stored JSONB result
  // has no roundTrips, and the UI falls back to the raw `trades` fills.
  roundTrips: z.array(BacktestRoundTripSchema).default(() => []),
  perSymbol: z.array(BacktestPerSymbolSchema),
  // Defaulted so runs persisted before this field shipped still parse (their
  // stored JSONB result has no decisionBreakdown). Factory form so each parse
  // gets fresh arrays rather than sharing one mutable instance across results.
  decisionBreakdown: DecisionBreakdownSchema.default(() => ({ metrics: [], logs: [] })),
  // Per-symbol data-quality warnings: a symbol whose candle coverage falls short
  // of the requested range (delisting, halt, thin liquidity) makes its results
  // unreliable, and a basket backtest silently survivor-biases toward the
  // symbols that did trade the whole window. Surfaced, not silently dropped.
  // Factory default keeps runs persisted before this field shipped parseable.
  dataWarnings: z.array(z.string()).default(() => []),
  // Performance split by market regime. Defaulted so runs persisted before this
  // field shipped still parse (empty = not computed / window too short to label).
  regimeBreakdown: z.array(RegimeSegmentSchema).default(() => []),
  // Out-of-sample holdout metrics (most-recent slice of the run). Nullable +
  // defaulted so runs persisted before this field shipped still parse; `null`
  // also means "too short to carve a holdout".
  outOfSample: OutOfSampleSegmentSchema.nullable().default(null),
  // The full strategy config the run actually executed: the profile base merged
  // with the run's override, then schema-parsed. Persisted so the results UI can
  // attribute each entry-blocker to the exact setting that armed it (a partial
  // override carries only the changed keys, so the override alone names the wrong
  // setting). Opaque at the contract layer like `strategyConfigOverride`.
  // Nullable + defaulted so runs persisted before this field shipped still parse;
  // the UI then falls back to merging the current profile config with the override.
  resolvedConfig: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type BacktestResult = z.infer<typeof BacktestResultSchema>;

/** Row in the runs list for a profile. */
export const BacktestListItemSchema = z.object({
  runId: z.uuid(),
  status: BacktestStatus,
  progress: z.number().int().min(0).max(100),
  symbols: z.array(z.string()),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable().optional(),
  // The backtest data window this run covered (ms epoch), from its launch params.
  // The list shows the period tested, not just when the row was created.
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative(),
  totalReturnPct: z.number().nullable(),
});
export type BacktestListItem = z.infer<typeof BacktestListItemSchema>;

/**
 * Paginated reply for the past-runs list. `nextCursor` is opaque (composite
 * `<createdAt-iso>__<id>` so a same-timestamp group is paged stably); the
 * client echoes it back via `?cursor=`. Null when the page came up shorter
 * than the requested limit (no more history).
 */
export const BacktestListResponse = z.object({
  items: z.array(BacktestListItemSchema),
  nextCursor: z.string().nullable(),
  // Total runs matching the active filter (ignoring the page cursor), so the UI
  // can show "N runs · page X of Y" over cursor-based paging.
  total: z.number().int().nonnegative(),
});
export type BacktestListResponse = z.infer<typeof BacktestListResponse>;

/**
 * Response of POST .../backtests — the id to poll. `deduped` is true when the
 * create matched an already-completed standalone run with an identical backtest
 * signature: the API returns that existing run instead of enqueuing a new one,
 * so the client anchors to it rather than showing a fresh in-progress run.
 * Defaulted to false so a fresh enqueue (and any response predating the flag)
 * parses as not-deduped.
 */
export const BacktestCreatedSchema = z.object({
  runId: z.uuid(),
  deduped: z.boolean().default(false),
  /**
   * Present only on a launch that went through but could not be fully checked
   * against the run's target symbols. Absent on a clean launch and on a dedup
   * hit, which enqueues nothing and therefore checks nothing.
   */
  diagnostics: SaveDiagnostics,
});
export type BacktestCreated = z.infer<typeof BacktestCreatedSchema>;

/**
 * GET .../backtests/{runId} — the status, plus the embedded result once the
 * run is done (null while it is queued/running/errored). The UI polls this and
 * renders the result when `status === 'done'`.
 */
export const BacktestRunDetailSchema = BacktestRunStatusSchema.extend({
  result: BacktestResultSchema.nullable(),
  // The launch params (window, intervals, fees, override), always present from
  // creation. Carried on the detail so the UI can seed its Configure surface from
  // a run that is still queued/running — its `result` (and the config inside it)
  // is null until done, but `params` holds the strategyConfigOverride and window.
  params: BacktestParamsSchema,
  // The run this one forked from (durable comparison lineage), or null for a
  // standalone run. Defaulted so a row/fixture predating the column parses as
  // standalone; the route always emits the real value.
  parentRunId: z.uuid().nullable().default(null),
});
export type BacktestRunDetail = z.infer<typeof BacktestRunDetailSchema>;

/**
 * Split a config-patch path into nested-set segments, accepting both dotted keys
 * and bracketed array indices: `technicals.intervals[2].whenNeutral` becomes
 * `['technicals', 'intervals', '2', 'whenNeutral']`. The advisor writes array
 * elements in bracket notation, so a plain `path.split('.')` leaves `intervals[2]`
 * as one literal key; the patch then lands on a stray key and never touches the
 * real array element. That no-op slips through schema re-validation because the
 * stray key is stripped, so the suggestion reads as valid while doing nothing.
 * The API patch applier and the web form-seeder both tokenize through here so the
 * two cannot drift. Empty segments are dropped so a leading index parses cleanly.
 */
export function tokenizePath(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((seg) => seg.length > 0);
}

/**
 * One suggested config change from the LLM advisor: a human rationale plus the
 * concrete path/value patches to apply. Each
 * `changes[].value` is opaque JSON typed by the field's own schema; the API
 * applies the patches to the run's config and validates the result against the
 * strategy schema, dropping any suggestion that does not parse — so the UI only
 * ever sees schema-valid changes. `overfitRisk` is the model's own flag that a
 * change may curve-fit the in-sample window rather than generalise.
 */
/**
 * Which advisor variant to run. `safe` (default) proposes only changes likely to
 * improve forward performance and says HOLD when nothing beats holding cash. The
 * other four are opt-in EXPLORE variants, each a bold, higher-variance lens on the
 * same run: `ride-trend` loosens exits so winners run, `trade-more` loosens entry
 * throttles to raise the trade count, `aggressive` leans on larger sizing /
 * exposure, `defensive` cuts drawdown and downside. All EXPLORE variants stay
 * gated by the out-of-sample live gate before any suggestion can go live.
 */
export const ImproveConfigMode = z.enum([
  'safe',
  'ride-trend',
  'trade-more',
  'aggressive',
  'defensive',
]);
export type ImproveConfigMode = z.infer<typeof ImproveConfigMode>;

export const ConfigSuggestionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  rationale: z.string().min(1),
  changes: z.array(z.object({ path: z.string().min(1), value: z.unknown() })).min(1),
  expectedEffect: z.string(),
  overfitRisk: z.enum(['low', 'medium', 'high']),
});
export type ConfigSuggestion = z.infer<typeof ConfigSuggestionSchema>;

/**
 * A suggestion the model returned that the API dropped because its patched
 * config fails the strategy schema (an out-of-bounds value, a wrong-typed field).
 * Carried so the UI can show the operator that a suggestion existed and WHY it
 * was skipped, instead of silently collapsing to "no suggestion" — a returned-
 * but-invalid suggestion must never read as "the model found nothing". `reason`
 * is the first schema violation as `field.path: message`.
 */
export const DroppedSuggestionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  reason: z.string().min(1),
});
export type DroppedSuggestion = z.infer<typeof DroppedSuggestionSchema>;

/**
 * Reply of the backtest config advisor: an overall plain-language read of the
 * run plus zero or more suggestions. Empty `suggestions` is a valid, honest
 * answer ("no change beats holding cash"). The advisor never writes config or
 * runs anything — the operator reviews each suggestion, loads the chosen ones
 * into Setup, re-runs, and the out-of-sample gate still decides go-live.
 *
 * `dropped` lists suggestions the model returned that failed schema re-validation
 * and were not offered. It is optional so this schema doubles as the model-output
 * shape (the model never emits `dropped`; the API computes it) and so a response
 * from an older server still parses. The HTTP route always sets it.
 */
export const ImproveConfigResponseSchema = z.object({
  summary: z.string(),
  suggestions: z.array(ConfigSuggestionSchema),
  dropped: z.array(DroppedSuggestionSchema).optional(),
});
export type ImproveConfigResponse = z.infer<typeof ImproveConfigResponseSchema>;

/**
 * Stable signature of a suggestion's effect: its change set as sorted
 * `path=value` pairs. Two suggestions with the same signature are the same edit.
 */
const suggestionSignature = (s: ConfigSuggestion): string =>
  s.changes
    .map((c) => `${c.path}=${JSON.stringify(c.value)}`)
    .sort()
    .join('|');

/**
 * Merge multi-sample advisor responses into one. Concatenate their suggestions,
 * drop exact-duplicate edits (same change signature — different samples often
 * re-propose the same tweak), and keep ids unique by suffixing a collision so the
 * UI can still key/toggle by id. The summary is the first non-empty one. Pure, so
 * the route can widen a variant by sampling the model more than once without
 * showing the operator the same card twice.
 */
export function mergeImproveResponses(
  responses: readonly ImproveConfigResponse[],
): ImproveConfigResponse {
  const seenSig = new Set<string>();
  const usedIds = new Set<string>();
  const suggestions: ConfigSuggestion[] = [];
  for (const r of responses) {
    for (const s of r.suggestions) {
      const sig = suggestionSignature(s);
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      let id = s.id;
      for (let n = 2; usedIds.has(id); n++) id = `${s.id}-${n}`;
      usedIds.add(id);
      suggestions.push({ ...s, id });
    }
  }
  // Prefer a summary from a sample that actually contributed suggestions, so the
  // headline can't read "no change beats holding" while the card shows another
  // sample's edits; fall back to the first non-empty summary.
  const summary =
    responses.find((r) => r.suggestions.length > 0 && r.summary.trim() !== '')?.summary ??
    responses.find((r) => r.summary.trim() !== '')?.summary ??
    '';
  return { summary, suggestions };
}

/**
 * Repair a model's raw advisor output before schema validation. Forced
 * `tool_choice` does not guarantee a well-typed tool input: some models
 * (observed on claude-sonnet-5) serialize the `suggestions` array as a JSON
 * string, or stuff the whole `{summary, suggestions}` object into that string,
 * and omit `summary`. Coerce those shapes back; leave anything else untouched so
 * a genuinely malformed reply still fails `ImproveConfigResponseSchema.parse`
 * with a clear field path. Applied by both the server tool-call path and the
 * manual paste-back path so one repair covers every model on either entry point.
 */
export function coerceImproveConfigModelShape(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  if (typeof obj['suggestions'] === 'string') {
    try {
      const parsed: unknown = JSON.parse(obj['suggestions']);
      if (Array.isArray(parsed)) {
        obj['suggestions'] = parsed;
      } else if (parsed !== null && typeof parsed === 'object') {
        // The whole {summary, suggestions} object was stuffed into the string.
        const inner = parsed as Record<string, unknown>;
        if (Array.isArray(inner['suggestions'])) obj['suggestions'] = inner['suggestions'];
        if (obj['summary'] === undefined && typeof inner['summary'] === 'string') {
          obj['summary'] = inner['summary'];
        }
      }
    } catch {
      // Not JSON — leave as-is; the parse below reports the mismatch.
    }
  }
  // A missing/non-string summary is cosmetic; default it so a usable set of
  // suggestions is never lost to a blank overview field.
  if (typeof obj['summary'] !== 'string') obj['summary'] = '';
  return obj;
}

/**
 * Parse a model's raw advisor output into an {@link ImproveConfigResponse},
 * tolerating per-suggestion malformation. First {@link coerceImproveConfigModelShape}
 * repairs the top-level shape, then each suggestion is validated on its own and
 * the malformed ones are dropped rather than failing the whole response — a
 * forced tool call can still return one bad item (empty `changes`, wrong-typed
 * field) amid good ones, and one bad item must not sink the rest. Shared by the
 * server tool-call path and the manual paste-back path. The route re-validates
 * each surviving suggestion's patched config against the strategy schema after
 * this (that is where out-of-bounds values become `dropped`); this step only
 * enforces the suggestion's own wire shape.
 */
export function parseImproveConfigModelOutput(raw: unknown): ImproveConfigResponse {
  const shaped = coerceImproveConfigModelShape(raw);
  const obj = (shaped ?? {}) as Record<string, unknown>;
  const summary = typeof obj['summary'] === 'string' ? obj['summary'] : '';
  const list = Array.isArray(obj['suggestions']) ? obj['suggestions'] : [];
  const suggestions: ConfigSuggestion[] = [];
  for (const s of list) {
    const parsed = ConfigSuggestionSchema.safeParse(s);
    if (parsed.success) suggestions.push(parsed.data);
  }
  return { summary, suggestions };
}

/**
 * The exact advisor prompt rendered for manual use (GET .../advisor/manual/prompt).
 * The operator copies it into claude.ai and pastes the reply back. Served even
 * when server-side assist is off, since building the prompt needs no credential.
 * (Server-side assist can run against either a Console API key or a Claude Code
 * OAuth token; this manual path is for operators who configure neither.)
 */
export const ImproveConfigPromptResponseSchema = z.object({ prompt: z.string().min(1) });
export type ImproveConfigPromptResponse = z.infer<typeof ImproveConfigPromptResponseSchema>;

/**
 * The model reply the operator pasted back from claude.ai (POST
 * .../advisor/manual). The API extracts the JSON object from it, validates
 * the shape, and re-validates each patch against the strategy schema — the same
 * guard the server-call path applies — before the UI sees any suggestion.
 */
// Cap the reply: a chat answer with a few suggestions is well under this; the
// bound rejects an oversized body at the route boundary (422) before JSON.parse,
// so a paste can't buffer/parse megabytes on the single-threaded API loop.
export const ImproveConfigManualRequestSchema = z.object({
  reply: z.string().min(1).max(256_000),
});
