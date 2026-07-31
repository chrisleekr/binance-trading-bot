import type { Decimal } from '@app/money';
import type {
  AccountSnapshot,
  Candle,
  CandleInterval,
  Clock,
  OrderIntent,
  OrderParams,
  SymbolInfo,
} from '@app/strategy-core';

/**
 * Source of historical market data for a run. The engine consumes it as an
 * async stream so the data layer (DB-backed, in the worker) stays out of
 * this pure package — the engine never imports pg/ioredis. A
 * fixture-backed in-memory source drives the unit tests.
 *
 * Ordering contract: ticks MUST arrive in non-decreasing `candle.closeTimeMs`
 * order ACROSS all symbols. A portfolio run shares one account, so a buy on
 * one symbol must constrain a later buy on another in the true time order;
 * out-of-order ticks would mis-sequence the shared balance. The data layer
 * owns the k-way merge that guarantees this — {@link mergeCandleTicks} is the
 * helper for an array-backed source.
 */
export interface MarketDataSource {
  stream(req: StreamRequest): AsyncIterable<MarketTick>;
}

export interface StreamRequest {
  readonly symbols: readonly string[];
  readonly intervals: readonly CandleInterval[];
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * One unit of replay input. `candle-close` advances the simulated clock and
 * triggers a tick; the engine accumulates the candle into the per-interval
 * window first. Only closed candles are streamed — the look-ahead-safety
 * rule (a tick never sees the candle it will be filled against) is the
 * data layer's contract, asserted by the engine via `candle.isClosed`.
 */
export interface MarketTick {
  readonly kind: 'candle-close';
  readonly symbol: string;
  readonly interval: CandleInterval;
  readonly candle: Candle;
  /**
   * Finer intra-candle bars within {@link candle} (timeframe-detail), in time
   * order, for the OHLCV fill model to cross orders against. Absent when the
   * run streams only the coarse interval; the model then treats `candle`
   * itself as the sole bar.
   */
  readonly detailCandles?: readonly Candle[] | undefined;
}

/**
 * Simulated fill engine. Pure and synchronous: given an order and the
 * market/account context, it returns the outcome without mutating anything
 * — the {@link BacktestExecutor} applies the outcome to the account. The
 * realistic OHLCV model and the ideal model both satisfy this shape.
 */
export interface FillModel {
  fill(input: FillInput): FillOutcome;
  /**
   * The account funds an order commits while it rests. The executor locks this
   * amount (free → locked) when the order goes on the book and releases it on
   * fill/cancel, exactly as a real exchange does: a resting BUY locks the quote
   * it will spend, a resting SELL locks the base it will deliver. Sized to cover
   * what {@link fill}'s outcome will later deduct (notional + fee for a buy, qty
   * for a sell) so the lock and the eventual deduction net out. Only invoked for
   * orders that rest; an immediate-fill model may return any consistent value.
   */
  reserve(input: ReserveInput): FillReservation;
}

export interface ReserveInput {
  readonly intent: OrderIntent;
  readonly params: OrderParams;
  readonly symbolInfo: SymbolInfo;
}

/** Funds an order commits while it rests, in one asset. */
export interface FillReservation {
  readonly asset: string;
  readonly amount: Decimal;
}

/**
 * When the executor is asking the model about an order:
 *   - `place`   — the order was just submitted on the current candle. A
 *                 realistic model returns `rest` here so the order cannot fill
 *                 on the same candle the decision was made (look-ahead safety).
 *   - `resting` — a previously-rested order is being re-evaluated against a
 *                 later candle; this is where realistic fills happen.
 * The ideal model ignores the phase and fills immediately on `place`.
 */
export type FillPhase = 'place' | 'resting';

export interface FillInput {
  readonly intent: OrderIntent;
  readonly params: OrderParams;
  readonly market: FillMarket;
  readonly account: AccountSnapshot;
  readonly symbolInfo: SymbolInfo;
  readonly clock: Clock;
  /** Whether this is the placement evaluation or a resting re-evaluation. Defaults to `place`. */
  readonly phase?: FillPhase;
}

export interface FillMarket {
  /** Last traded price = close of the most recent closed candle (Decimal). */
  readonly lastPrice: Decimal;
  /** The candle the order is evaluated against. */
  readonly lastCandle: Candle;
  /**
   * Intra-candle bars of a finer interval within {@link lastCandle}, in time
   * order (timeframe-detail). When empty, the model treats `lastCandle`
   * itself as the sole bar. The detail-bar ordering decides which of several
   * crossable LIMITs fills first.
   */
  readonly detailCandles?: readonly Candle[] | undefined;
}

export interface Fill {
  /** Execution price (Decimal). */
  readonly price: Decimal;
  /** Filled base quantity (Decimal). */
  readonly qty: Decimal;
  /** Fee charged on this fill, in basis points of notional. */
  readonly feeBps: number;
  readonly tsMs: number;
}

export type FillRejectReason =
  | 'min-notional'
  | 'step-size'
  | 'insufficient-balance'
  | 'liquidity'
  | 'no-fill';

export type FillOutcome =
  | { readonly kind: 'filled'; readonly fills: readonly Fill[]; readonly latencyMs: number }
  | {
      readonly kind: 'partial';
      readonly fills: readonly Fill[];
      readonly remainingQty: Decimal;
      readonly latencyMs: number;
    }
  | { readonly kind: 'rejected'; readonly reason: FillRejectReason; readonly latencyMs: number }
  // The order did not fill on this candle but remains live — the executor
  // holds it on the resting book and re-evaluates it on later candles.
  | { readonly kind: 'rest' };

/** A single simulated execution recorded for the report and metrics. */
export interface BacktestTrade {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly reason: OrderIntent['reason'];
  /** Execution price as a decimal-string (revived to Decimal at the boundary). */
  readonly price: string;
  readonly qty: string;
  /** Fee paid in quote asset, decimal-string. */
  readonly feeQuote: string;
  readonly tsMs: number;
}

/** One point on the portfolio equity curve, valued in the quote asset. */
export interface EquityPoint {
  readonly tsMs: number;
  /** Total equity in quote terms, decimal-string. */
  readonly equity: string;
}

/** One point on the underwater (drawdown) curve; `ddPct` is <= 0. */
export interface DrawdownPoint {
  readonly tsMs: number;
  /** Drawdown from the running equity peak, as a number percentage (<= 0). */
  readonly ddPct: number;
}

/**
 * Headline performance metrics. Money amounts (balances, profit, per-trade
 * P&L) are decimal-strings; unitless statistics (ratios) and percentages are
 * numbers. Field names mirror the wire contract so the worker's mapping to it
 * is an identity. All fields are well-defined for a zero-trade run (no
 * NaN/Infinity): ratios collapse to 0, the open-ended ones to null.
 */
export interface BacktestMetrics {
  readonly startingBalance: string;
  readonly finalBalance: string;
  readonly absoluteProfit: string;
  readonly totalReturnPct: number;
  readonly cagrPct: number;
  readonly marketChangePct: number;
  readonly dcaChangePct: number;
  readonly alphaVsHoldPct: number;
  readonly alphaVsDcaPct: number;
  // null — undefined, not 0 — when too few trades to trust the ratio or the
  // denominator is zero (zero variance, or zero downside for Sortino).
  readonly sharpe: number | null;
  readonly sortino: number | null;
  readonly calmar: number;
  readonly sqn: number | null;
  readonly maxDrawdownPct: number;
  readonly absoluteDrawdown: string;
  readonly drawdownStartMs: number | null;
  readonly drawdownEndMs: number | null;
  readonly totalTrades: number;
  readonly winRate: number;
  readonly wins: number;
  readonly losses: number;
  readonly profitFactor: number | null;
  readonly expectancy: string;
  readonly bestTradePct: number | null;
  readonly worstTradePct: number | null;
  readonly avgTradePnl: string;
  readonly avgTradeDurationMs: number | null;
}

/** Per-symbol breakdown for a portfolio run. */
export interface BacktestPerSymbol {
  readonly symbol: string;
  readonly tradeCount: number;
  readonly pnlQuote: string;
}

/**
 * One realised round-trip: a reducing SELL paired against the average cost of
 * the position it closed (average-cost accounting, so a grid that stacks N buys
 * before one sell yields one round-trip per reducing sell). Money fields are
 * decimal-strings. This is the per-trade record the headline metrics are
 * reduced from — surfaced so the UI can show a trade table, P&L / holding-time
 * distributions, and exit-reason attribution instead of only the aggregates.
 */
export interface BacktestRoundTrip {
  readonly symbol: string;
  /** Average buy price of the closed portion, excluding fees, decimal-string. */
  readonly entryPrice: string;
  /** Sell fill price that closed the portion, decimal-string. */
  readonly exitPrice: string;
  /** Base quantity closed by this round-trip, decimal-string. */
  readonly qty: string;
  /** Realised P&L net of all fees (allocated buy fees + sell fee), decimal-string. */
  readonly pnlQuote: string;
  /** P&L over the cost basis of the closed portion, as a number percentage. */
  readonly returnPct: number;
  /** Total fees attributed to this round-trip (allocated buy fees + sell fee), decimal-string. */
  readonly feeQuote: string;
  /** Epoch ms the position was opened (first buy of the closed lot). */
  readonly openTsMs: number;
  /** Epoch ms the closing sell filled. */
  readonly closeTsMs: number;
  readonly durationMs: number;
  /** The closing SELL's reason (e.g. `tt-trailing-stop`, `tt-stop-loss`). */
  readonly exitReason: string;
}

/**
 * Objective market regime used to attribute performance over the run: the
 * benchmark symbol's daily close vs its moving average. `bull` = confirmed
 * uptrend, `bear` = confirmed downtrend, `neutral` = chop. This is the engine's
 * own market-level lens, NOT a strategy's regime config — the backtest package
 * is strategy-agnostic and cannot read a plugin's settings.
 */
export type MarketRegime = 'bull' | 'bear' | 'neutral';

/**
 * Performance attributed to one market regime. `returnPct` is the strategy's
 * equity return compounded over the candle steps that fell in this regime;
 * `holdReturnPct` is the benchmark symbol's buy-and-hold over the SAME steps, so
 * `alphaVsHoldPct` answers "did the strategy beat holding while the market was in
 * this regime?". A long-only strategy that is positive only in `bull` and
 * negative-or-flat elsewhere has no real edge — it is holding with extra steps.
 */
export interface RegimeSegment {
  readonly regime: MarketRegime;
  readonly returnPct: number;
  readonly holdReturnPct: number;
  readonly alphaVsHoldPct: number;
  readonly trades: number;
  readonly winRate: number;
  readonly profitFactor: number | null;
  /** Mean realised P&L per trade in this regime, decimal-string. */
  readonly expectancy: string;
}

/**
 * Out-of-sample validation slice: the metrics recomputed over only the most
 * recent {@link fraction} of the run's time span (a fixed analysis constant, not
 * a strategy or policy input — the engine is agnostic to both). An operator tunes
 * a config against the full window, so the full-window metrics are in-sample and
 * can be curve-fit; this recent slice the tuning never targeted is the honest
 * test set. A strategy whose edge exists only in-sample shows a strong full-run
 * profit factor but a weak (or absent) one here. `null` when the run is too short
 * to carve a holdout (fewer than two equity points).
 */
export interface OutOfSampleSegment {
  /** Fraction of the time span held out (e.g. 0.3 = the most-recent 30%). */
  readonly fraction: number;
  /** Start of the holdout window, epoch ms (the in-sample/holdout cut point). */
  readonly fromMs: number;
  /** End of the holdout window, epoch ms (the run's last equity point). */
  readonly toMs: number;
  readonly returnPct: number;
  readonly holdReturnPct: number;
  readonly alphaVsHoldPct: number;
  readonly trades: number;
  readonly winRate: number;
  readonly profitFactor: number | null;
  /** Mean realised P&L per trade in the holdout, decimal-string. */
  readonly expectancy: string;
}

/**
 * One aggregated strategy metric over the run: a counter bucket keyed by
 * metric name and tags. The engine sums emissions without interpreting their
 * meaning, so any strategy's counters roll up unchanged (e.g. TT's
 * `tt_grid_buy_emit`, or `tt_first_buy_skipped` split by its `reason` tag).
 */
export interface DecisionBreakdownMetric {
  readonly name: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly count: number;
}

/**
 * One aggregated strategy log over the run: a bucket keyed by level, message,
 * and the `reason` context field. The buy gate reports its vetoes on this
 * channel (`tt-technicals-gate-veto` / `tt-indicator-gate-veto` carry
 * `context.reason`), so aggregating logs surfaces "why a buy was vetoed"
 * without the strategy emitting a dedicated metric. Its frozen tick output
 * stays untouched.
 */
export interface DecisionBreakdownLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly reason: string | null;
  readonly count: number;
}

/**
 * Behavioural "why" summary for a run. The engine consumes the strategy's
 * `decisions` to drive fills; these two channels (`metrics`, `logs`) would
 * otherwise be discarded. Aggregated here they answer "why did it trade, or
 * not": buys emitted, skips by reason, gate vetoes by reason, which the
 * equity curve alone cannot.
 */
export interface DecisionBreakdown {
  readonly metrics: readonly DecisionBreakdownMetric[];
  readonly logs: readonly DecisionBreakdownLog[];
}

/**
 * Engine output. `equityCurve` and `trades` are the raw series; `summary`
 * holds the cheap headline figures. The full risk-adjusted metric set
 * (Sharpe/Sortino/Calmar/drawdown/…) is computed by a separate metrics
 * module that consumes these series.
 */
export interface BacktestReport {
  readonly equityCurve: readonly EquityPoint[];
  readonly drawdownSeries: readonly DrawdownPoint[];
  readonly trades: readonly BacktestTrade[];
  /**
   * Realised round-trips (one per reducing sell), in closing-sell order. The
   * headline trade metrics are reduced from these; surfaced raw so the UI can
   * drill into per-trade P&L, holding time, and exit reason. Empty for a run that
   * never closed a position.
   */
  readonly roundTrips: readonly BacktestRoundTrip[];
  readonly perSymbol: readonly BacktestPerSymbol[];
  readonly metrics: BacktestMetrics;
  readonly summary: BacktestSummary;
  readonly decisionBreakdown: DecisionBreakdown;
  /**
   * Performance split by market regime (bull/neutral/bear), in that fixed
   * order. Empty when the run is too short to classify any regime (needs enough
   * daily history for the moving average). Regimes the window never reached are
   * omitted rather than zero-filled.
   */
  readonly regimeBreakdown: readonly RegimeSegment[];
  /**
   * Metrics recomputed over only the most-recent slice of the run, as an
   * out-of-sample check against curve-fitting the full (in-sample) window.
   * `null` when the run is too short to carve a holdout.
   */
  readonly outOfSample: OutOfSampleSegment | null;
}

export interface BacktestSummary {
  /** Starting equity in quote asset, decimal-string. */
  readonly startingBalance: string;
  /** Final equity in quote asset, decimal-string. */
  readonly finalBalance: string;
  /** (final - start) / start, as a number percentage. */
  readonly totalReturnPct: number;
  readonly tradeCount: number;
}
