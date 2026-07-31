import { Decimal } from '@app/money';
import type {
  BacktestMetrics,
  BacktestPerSymbol,
  BacktestRoundTrip,
  BacktestTrade,
  DrawdownPoint,
  EquityPoint,
  OutOfSampleSegment,
  RegimeSegment,
} from './types.js';
import {
  computeHoldoutSegment,
  computeRegimeBreakdown,
  HOLDOUT_FRACTION,
  type PricePoint,
} from './regime.js';

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
// Annualizing a short run is meaningless: the (1/years) exponent balloons a
// small period return into an absurd figure (a 2-day +5% run annualizes to
// ~7e7%) — a *finite* number, so a bare Infinity guard does not catch it. This
// is the same reason Sharpe/Sortino are kept raw (see computeRiskRatios). Only
// annualize over a horizon long enough for the extrapolation to mean something;
// below it, report CAGR (and thus Calmar) as 0 and let the UI show the period
// return instead. 90 days caps the exponent near 4x.
const MIN_CAGR_DAYS = 90;
const MIN_CAGR_YEARS = (MIN_CAGR_DAYS * 24 * 60 * 60 * 1000) / MS_PER_YEAR;
// A per-trade risk ratio (Sharpe/Sortino/SQN) over a handful of trades is noise,
// not signal: two lucky wins yield a Sharpe of 6 that no live edge supports.
// Below this many closed trades the ratios are reported `null` ("not enough
// data") rather than a falsely-precise number, so a downstream reader (the
// advisor, the results view) treats it as "no data", not a strong score.
const MIN_RATIO_TRADES = 10;
const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

export interface ComputeMetricsInput {
  readonly equityCurve: readonly EquityPoint[];
  readonly trades: readonly BacktestTrade[];
  /** Opening equity in quote asset. */
  readonly startingBalance: Decimal;
  /** Buy-and-hold benchmark over the same range, as a number percentage. */
  readonly marketChangePct: number;
  /** Dollar-cost-average benchmark over the same range, as a number percentage. */
  readonly dcaChangePct: number;
  /**
   * Benchmark symbol's close series (decimal-string) for regime attribution.
   * Omitted (or empty) yields no regime breakdown — the metric set is otherwise
   * unchanged.
   */
  readonly benchmarkPrices?: readonly PricePoint[];
  /**
   * Portfolio equity sampled on the same cadence as {@link benchmarkPrices}, used
   * as the strategy-return series for the regime split so it compounds over the
   * same steps as the hold series. Falls back to the full equity curve (correct
   * for a single-symbol run, where the two cadences coincide).
   */
  readonly benchmarkEquity?: readonly EquityPoint[];
}

export interface MetricsResult {
  readonly metrics: BacktestMetrics;
  readonly drawdownSeries: readonly DrawdownPoint[];
  readonly perSymbol: readonly BacktestPerSymbol[];
  readonly roundTrips: readonly BacktestRoundTrip[];
  readonly regimeBreakdown: readonly RegimeSegment[];
  readonly outOfSample: OutOfSampleSegment | null;
}

/**
 * A realised round-trip slice: one reducing SELL against average cost. `pnl` and
 * `returnFraction` are the authoritative figures the metrics reduce from; the
 * remaining fields are for display (entry/exit price, quantity, attributed fee,
 * exit reason) and never feed a metric, so adding them does not move any number.
 */
interface ClosedTrade {
  readonly symbol: string;
  readonly pnl: Decimal;
  readonly returnFraction: Decimal; // pnl / cost of the sold portion
  readonly durationMs: number;
  readonly openTsMs: number;
  readonly closeTsMs: number;
  readonly entryPrice: Decimal; // average buy price of the closed portion, excl. fees
  readonly exitPrice: Decimal; // sell fill price
  readonly qty: Decimal; // base quantity closed
  readonly feeQuote: Decimal; // allocated buy fees + sell fee
  readonly exitReason: string;
}

/**
 * Compute the full metric set from the equity curve and the trade list. All
 * money math is Decimal; ratios/percentages are converted to numbers only at
 * the boundary. Every field is defined for a zero-trade or zero-variance run
 * — ratios collapse to 0 and open-ended figures to null rather than NaN.
 */
export function computeMetrics(input: ComputeMetricsInput): MetricsResult {
  const { equityCurve, trades, startingBalance, marketChangePct, dcaChangePct } = input;

  const finalBalance =
    equityCurve.length > 0
      ? new Decimal(equityCurve[equityCurve.length - 1]?.equity ?? startingBalance.toString())
      : startingBalance;
  const absoluteProfit = finalBalance.sub(startingBalance);
  const totalReturnPct = startingBalance.lte(0)
    ? 0
    : absoluteProfit.div(startingBalance).mul(HUNDRED).toNumber();

  const { drawdownSeries, maxDrawdownPct, absoluteDrawdown, drawdownStartMs, drawdownEndMs } =
    computeDrawdown(equityCurve);

  const cagrPct = computeCagr(startingBalance, finalBalance, equityCurve);

  const closed = pairTrades(trades);
  const trade = computeTradeStats(closed);
  const perSymbol = computePerSymbol(closed, trades);
  const roundTrips: BacktestRoundTrip[] = closed.map((c) => ({
    symbol: c.symbol,
    entryPrice: c.entryPrice.toString(),
    exitPrice: c.exitPrice.toString(),
    qty: c.qty.toString(),
    pnlQuote: c.pnl.toString(),
    returnPct: c.returnFraction.mul(HUNDRED).toNumber(),
    feeQuote: c.feeQuote.toString(),
    openTsMs: c.openTsMs,
    closeTsMs: c.closeTsMs,
    durationMs: c.durationMs,
    exitReason: c.exitReason,
  }));
  const regimeTrades = closed.map((c) => ({ pnl: c.pnl, openTsMs: c.openTsMs }));
  const regimeBreakdown = computeRegimeBreakdown(
    regimeTrades,
    input.benchmarkPrices ?? [],
    input.benchmarkEquity ?? equityCurve,
  );
  const outOfSample = computeHoldoutSegment(
    regimeTrades,
    input.benchmarkPrices ?? [],
    input.benchmarkEquity ?? equityCurve,
    HOLDOUT_FRACTION,
  );

  const metrics: BacktestMetrics = {
    startingBalance: startingBalance.toString(),
    finalBalance: finalBalance.toString(),
    absoluteProfit: absoluteProfit.toString(),
    totalReturnPct,
    cagrPct,
    marketChangePct,
    dcaChangePct,
    // Alpha = the strategy's return minus what passively holding (or averaging
    // into) the same basket would have earned. This is the honest scorecard:
    // a positive total return with negative alpha means the strategy
    // underperformed doing nothing.
    alphaVsHoldPct: totalReturnPct - marketChangePct,
    alphaVsDcaPct: totalReturnPct - dcaChangePct,
    sharpe: trade.sharpe,
    sortino: trade.sortino,
    calmar: computeCalmar(cagrPct, maxDrawdownPct),
    sqn: trade.sqn,
    maxDrawdownPct,
    absoluteDrawdown: absoluteDrawdown.toString(),
    drawdownStartMs,
    drawdownEndMs,
    totalTrades: closed.length,
    winRate: trade.winRate,
    wins: trade.wins,
    losses: trade.losses,
    profitFactor: trade.profitFactor,
    expectancy: trade.expectancy.toString(),
    bestTradePct: trade.bestTradePct,
    worstTradePct: trade.worstTradePct,
    avgTradePnl: trade.avgTradePnl.toString(),
    avgTradeDurationMs: trade.avgTradeDurationMs,
  };

  return { metrics, drawdownSeries, perSymbol, roundTrips, regimeBreakdown, outOfSample };
}

/** Peak-to-trough drawdown walk over the equity curve, plus the underwater series. */
function computeDrawdown(equityCurve: readonly EquityPoint[]): {
  drawdownSeries: DrawdownPoint[];
  maxDrawdownPct: number;
  absoluteDrawdown: Decimal;
  drawdownStartMs: number | null;
  drawdownEndMs: number | null;
} {
  const drawdownSeries: DrawdownPoint[] = [];
  let peak: Decimal | null = null;
  let peakTsMs = 0;
  let maxDd = ZERO; // most-negative pct
  let absDd = ZERO;
  let ddStart: number | null = null;
  let ddEnd: number | null = null;

  for (const point of equityCurve) {
    const equity = new Decimal(point.equity);
    if (peak === null || equity.gt(peak)) {
      peak = equity;
      peakTsMs = point.tsMs;
    }
    const ddPct = peak.lte(0) ? ZERO : equity.sub(peak).div(peak).mul(HUNDRED);
    drawdownSeries.push({ tsMs: point.tsMs, ddPct: ddPct.toNumber() });
    if (ddPct.lt(maxDd)) {
      maxDd = ddPct;
      absDd = peak.sub(equity);
      ddStart = peakTsMs;
      ddEnd = point.tsMs;
    }
  }

  return {
    drawdownSeries,
    maxDrawdownPct: maxDd.toNumber(),
    absoluteDrawdown: absDd,
    drawdownStartMs: ddStart,
    drawdownEndMs: ddEnd,
  };
}

/** Compound annual growth rate as a number percentage; 0 when undefined. */
function computeCagr(start: Decimal, final: Decimal, equityCurve: readonly EquityPoint[]): number {
  if (start.lte(0) || final.lte(0) || equityCurve.length < 2) return 0;
  const firstTs = equityCurve[0]?.tsMs ?? 0;
  const lastTs = equityCurve[equityCurve.length - 1]?.tsMs ?? 0;
  const years = (lastTs - firstTs) / MS_PER_YEAR;
  if (years < MIN_CAGR_YEARS) return 0;
  // (final/start)^(1/years) - 1, all in Decimal to avoid IEEE drift.
  const ratio = final.div(start);
  const growth = ratio.pow(new Decimal(1).div(years));
  // A short, very profitable span annualizes to a value that is a *finite*
  // Decimal (decimal.js maxE is 9e15) but overflows IEEE-754 to Infinity at
  // toNumber(). Guard the resulting NUMBER, not the Decimal — the contract
  // types cagrPct as a finite number.
  const cagrPct = growth.sub(1).mul(HUNDRED).toNumber();
  return Number.isFinite(cagrPct) ? cagrPct : 0;
}

/** Calmar = CAGR / |max drawdown|; 0 when there is no drawdown. */
function computeCalmar(cagrPct: number, maxDrawdownPct: number): number {
  if (maxDrawdownPct === 0) return 0;
  // maxDrawdownPct is <= 0; negate to get its magnitude (avoids Math.abs,
  // which the strategy-purity rule bans).
  const magnitude = maxDrawdownPct < 0 ? -maxDrawdownPct : maxDrawdownPct;
  return cagrPct / magnitude;
}

/**
 * Pair fills into realised round-trip slices using average-cost accounting:
 * each BUY adds to the position cost basis; each SELL realises P&L against the
 * average cost of the portion it closes. Handles grid strategies that stack
 * several buys before selling. The fee on each fill is folded into cost
 * (buys) or netted from proceeds (sells).
 */
function pairTrades(trades: readonly BacktestTrade[]): ClosedTrade[] {
  interface Position {
    qty: Decimal;
    cost: Decimal; // total cost basis of the open qty (incl. buy fees)
    priceCost: Decimal; // total cost basis EXCLUDING fees (sum of price*qty)
    openTsMs: number;
  }
  const positions = new Map<string, Position>();
  const closed: ClosedTrade[] = [];

  for (const t of trades) {
    const qty = new Decimal(t.qty);
    const price = new Decimal(t.price);
    const fee = new Decimal(t.feeQuote);
    const pos = positions.get(t.symbol) ?? {
      qty: ZERO,
      cost: ZERO,
      priceCost: ZERO,
      openTsMs: t.tsMs,
    };

    if (t.side === 'BUY') {
      if (pos.qty.lte(0)) pos.openTsMs = t.tsMs; // opening a fresh position
      pos.qty = pos.qty.add(qty);
      pos.cost = pos.cost.add(price.mul(qty).add(fee));
      pos.priceCost = pos.priceCost.add(price.mul(qty));
      positions.set(t.symbol, pos);
      continue;
    }

    // SELL: realise against average cost of the sold portion. `cost` (incl. fees)
    // drives P&L exactly as before; `priceCost` is a parallel fee-free accumulator
    // used only to split the closed portion into a display entry price and the
    // buy fees attributed to it — it never touches `pnl`.
    if (pos.qty.lte(0)) continue; // sell with no position — nothing to realise
    const soldQty = Decimal.min(qty, pos.qty);
    const avgCost = pos.cost.div(pos.qty);
    const costOfSold = avgCost.mul(soldQty);
    const proceeds = price.mul(soldQty).sub(fee);
    const pnl = proceeds.sub(costOfSold);
    const avgEntryPrice = pos.qty.lte(0) ? ZERO : pos.priceCost.div(pos.qty);
    const priceOfSold = avgEntryPrice.mul(soldQty);
    closed.push({
      symbol: t.symbol,
      pnl,
      returnFraction: costOfSold.lte(0) ? ZERO : pnl.div(costOfSold),
      durationMs: t.tsMs - pos.openTsMs,
      openTsMs: pos.openTsMs,
      closeTsMs: t.tsMs,
      entryPrice: avgEntryPrice,
      exitPrice: price,
      qty: soldQty,
      // Buy fees attributed to the closed portion (costOfSold includes fees,
      // priceOfSold excludes them) plus this sell's fee.
      feeQuote: costOfSold.sub(priceOfSold).add(fee),
      exitReason: t.reason,
    });
    pos.qty = pos.qty.sub(soldQty);
    pos.cost = pos.cost.sub(costOfSold);
    pos.priceCost = pos.priceCost.sub(priceOfSold);
    positions.set(t.symbol, pos);
  }

  return closed;
}

interface TradeStats {
  readonly wins: number;
  readonly losses: number;
  readonly winRate: number;
  readonly profitFactor: number | null;
  readonly expectancy: Decimal;
  readonly avgTradePnl: Decimal;
  readonly bestTradePct: number | null;
  readonly worstTradePct: number | null;
  readonly avgTradeDurationMs: number | null;
  readonly sharpe: number | null;
  readonly sortino: number | null;
  readonly sqn: number | null;
}

function computeTradeStats(closed: readonly ClosedTrade[]): TradeStats {
  if (closed.length === 0) {
    return {
      wins: 0,
      losses: 0,
      winRate: 0,
      profitFactor: null,
      expectancy: ZERO,
      avgTradePnl: ZERO,
      bestTradePct: null,
      worstTradePct: null,
      avgTradeDurationMs: null,
      sharpe: null,
      sortino: null,
      sqn: null,
    };
  }

  let wins = 0;
  let losses = 0;
  let grossWin = ZERO;
  let grossLoss = ZERO;
  let pnlSum = ZERO;
  let durationSum = 0;
  // closed is non-empty here (guarded above); the ?? keeps the type honest.
  let best = closed[0]?.returnFraction ?? ZERO;
  let worst = closed[0]?.returnFraction ?? ZERO;

  for (const c of closed) {
    if (c.pnl.gt(0)) {
      wins += 1;
      grossWin = grossWin.add(c.pnl);
    } else if (c.pnl.lt(0)) {
      losses += 1;
      grossLoss = grossLoss.add(c.pnl.abs());
    }
    pnlSum = pnlSum.add(c.pnl);
    durationSum += c.durationMs;
    if (c.returnFraction.gt(best)) best = c.returnFraction;
    if (c.returnFraction.lt(worst)) worst = c.returnFraction;
  }

  const n = closed.length;
  const expectancy = pnlSum.div(n);
  const returns = closed.map((c) => c.returnFraction);
  const { sharpe, sortino } = computeRiskRatios(returns);

  return {
    wins,
    losses,
    // winRate is wins / total closed trades. A break-even (pnl == 0) trade is
    // neither a win nor a loss, so wins + losses can be < totalTrades.
    winRate: new Decimal(wins).div(n).mul(HUNDRED).toNumber(),
    profitFactor: grossLoss.lte(0) ? null : grossWin.div(grossLoss).toNumber(),
    expectancy,
    avgTradePnl: expectancy,
    bestTradePct: best.mul(HUNDRED).toNumber(),
    worstTradePct: worst.mul(HUNDRED).toNumber(),
    avgTradeDurationMs: new Decimal(durationSum).div(n).round().toNumber(),
    sharpe,
    sortino,
    sqn: computeSqn(returns),
  };
}

/**
 * Sharpe and Sortino over closed-trade return fractions — RAW (per-trade, not
 * annualised), so they stay interpretable for a backtest of any length
 * (annualizing a short run produces meaningless extremes). Both use the same
 * sample base (n-1) so they are on comparable footing: Sharpe over the spread
 * of all returns, Sortino over downside deviations below a zero target.
 *
 * Returns `null` — "undefined", not the misleading value 0 — when the sample is
 * too small to trust ({@link MIN_RATIO_TRADES}) or the denominator is zero:
 * zero return variance (Sharpe) or zero downside (Sortino, i.e. no losing
 * trades). A zero-downside Sortino is mathematically +infinity; reported 0 it
 * read as the WORST config, and a zero-loss backtest over few trades is almost
 * always a small-sample artifact, so `null` is the honest answer rather than
 * rewarding it.
 */
function computeRiskRatios(returns: readonly Decimal[]): {
  sharpe: number | null;
  sortino: number | null;
} {
  if (returns.length < MIN_RATIO_TRADES) return { sharpe: null, sortino: null };
  const mean = sum(returns).div(returns.length);
  const variance = sum(returns.map((r) => r.sub(mean).pow(2))).div(returns.length - 1);
  const std = variance.lte(0) ? ZERO : variance.sqrt();
  // Downside deviation below a 0 target, summed over negatives but divided by
  // the same (n-1) base as Sharpe — not by the downside count — so the two
  // ratios are comparable.
  const downsideSq = sum(returns.filter((r) => r.lt(0)).map((r) => r.pow(2)));
  const downsideVar = downsideSq.div(returns.length - 1);
  const downsideStd = downsideVar.lte(0) ? ZERO : downsideVar.sqrt();
  return {
    sharpe: std.lte(0) ? null : mean.div(std).toNumber(),
    sortino: downsideStd.lte(0) ? null : mean.div(downsideStd).toNumber(),
  };
}

/**
 * System Quality Number = sqrt(N) * mean / std of trade returns. `null` below
 * {@link MIN_RATIO_TRADES} or on zero variance, for the same reason as the risk
 * ratios: a two-trade SQN of 9 is noise, not a "holy grail" system.
 */
function computeSqn(returns: readonly Decimal[]): number | null {
  if (returns.length < MIN_RATIO_TRADES) return null;
  const mean = sum(returns).div(returns.length);
  const variance = sum(returns.map((r) => r.sub(mean).pow(2))).div(returns.length - 1);
  const std = variance.lte(0) ? ZERO : variance.sqrt();
  if (std.lte(0)) return null;
  return new Decimal(returns.length).sqrt().mul(mean).div(std).toNumber();
}

function computePerSymbol(
  closed: readonly ClosedTrade[],
  trades: readonly BacktestTrade[],
): BacktestPerSymbol[] {
  const pnlBySymbol = new Map<string, Decimal>();
  const countBySymbol = new Map<string, number>();
  for (const c of closed) {
    pnlBySymbol.set(c.symbol, (pnlBySymbol.get(c.symbol) ?? ZERO).add(c.pnl));
  }
  for (const t of trades) {
    countBySymbol.set(t.symbol, (countBySymbol.get(t.symbol) ?? 0) + 1);
  }
  return [...countBySymbol.keys()].sort().map((symbol) => ({
    symbol,
    tradeCount: countBySymbol.get(symbol) ?? 0,
    pnlQuote: (pnlBySymbol.get(symbol) ?? ZERO).toString(),
  }));
}

function sum(values: readonly Decimal[]): Decimal {
  let acc = ZERO;
  for (const v of values) acc = acc.add(v);
  return acc;
}
