import { Decimal } from '@app/money';
import type { EquityPoint, MarketRegime, OutOfSampleSegment, RegimeSegment } from './types.js';

const DAY_MS = 86_400_000;
const ZERO = new Decimal(0);
const ONE = new Decimal(1);
const HUNDRED = new Decimal(100);

// Market-regime lens for performance attribution: the benchmark symbol's daily
// close vs its 50-day simple moving average, confirmed over 2 consecutive
// closes — a self-contained "above/below the 50-day average" trend filter. It
// shares only the bull/neutral/bear VOCABULARY with the live Market Trend card,
// not its rule (the card adds a 10/150 EMA cross). An analysis constant, not a
// strategy input: the backtest engine is strategy-agnostic and must not read a
// plugin's regime config.
const MA_PERIOD = 50;
const CONFIRM_BARS = 2;

/** A realised round-trip slice tagged with the timestamp its position opened. */
export interface RegimeTrade {
  readonly pnl: Decimal;
  readonly openTsMs: number;
}

/** A close on the benchmark price series (decimal-string close at a timestamp). */
export interface PricePoint {
  readonly tsMs: number;
  readonly close: string;
}

interface ValuedPoint {
  readonly tsMs: number;
  readonly value: Decimal;
}

interface RegimeAcc {
  strat: Decimal; // compounded equity-step ratios (1 = no movement)
  hold: Decimal; // compounded benchmark-close ratios over the same steps
  trades: number;
  wins: number;
  grossWin: Decimal;
  grossLoss: Decimal;
  pnl: Decimal;
}

// `Math.floor` is banned in strategy packages; floor via Decimal instead.
const dayOf = (tsMs: number): number => new Decimal(tsMs).div(DAY_MS).floor().toNumber();

const parse = (s: string): Decimal | null => {
  try {
    return new Decimal(s);
  } catch {
    return null;
  }
};

/**
 * Compute per-regime performance for a run. Strategy return is the equity curve
 * compounded over the steps in each regime; hold return is the benchmark close
 * series compounded over the same steps; trades are bucketed by the regime in
 * effect when each position opened. Strat and hold accumulate into one per-regime
 * record so a regime always carries both. Returns segments for bull/neutral/bear
 * (in that order) the run actually reached; empty when the window is too short to
 * classify any regime.
 */
export function computeRegimeBreakdown(
  trades: readonly RegimeTrade[],
  benchmarkPrices: readonly PricePoint[],
  equityCurve: readonly EquityPoint[],
): RegimeSegment[] {
  const byDay = regimeByDay(dailyCloses(benchmarkPrices));
  if (byDay.size === 0) return [];
  const regimeOf = (tsMs: number): MarketRegime | undefined => byDay.get(dayOf(tsMs));

  const acc = new Map<MarketRegime, RegimeAcc>();
  const touch = (regime: MarketRegime): RegimeAcc => {
    let a = acc.get(regime);
    if (!a) {
      a = { strat: ONE, hold: ONE, trades: 0, wins: 0, grossWin: ZERO, grossLoss: ZERO, pnl: ZERO };
      acc.set(regime, a);
    }
    return a;
  };

  const equityPoints = valued(equityCurve.map((p) => ({ tsMs: p.tsMs, close: p.equity })));
  accumulateSteps(equityPoints, regimeOf, (regime, ratio) => {
    const a = touch(regime);
    a.strat = a.strat.mul(ratio);
  });
  accumulateSteps(valued(benchmarkPrices), regimeOf, (regime, ratio) => {
    const a = touch(regime);
    a.hold = a.hold.mul(ratio);
  });

  for (const t of trades) {
    const regime = regimeOf(t.openTsMs);
    if (!regime) continue;
    const a = touch(regime);
    a.trades += 1;
    if (t.pnl.gt(0)) {
      a.wins += 1;
      a.grossWin = a.grossWin.add(t.pnl);
    } else if (t.pnl.lt(0)) {
      a.grossLoss = a.grossLoss.add(t.pnl.abs());
    }
    a.pnl = a.pnl.add(t.pnl);
  }

  const order: readonly MarketRegime[] = ['bull', 'neutral', 'bear'];
  const segments: RegimeSegment[] = [];
  for (const regime of order) {
    const a = acc.get(regime);
    if (!a) continue; // a regime the window never reached is omitted, not zero-filled
    const returnPct = a.strat.sub(ONE).mul(HUNDRED).toNumber();
    const holdReturnPct = a.hold.sub(ONE).mul(HUNDRED).toNumber();
    segments.push({
      regime,
      returnPct,
      holdReturnPct,
      alphaVsHoldPct: returnPct - holdReturnPct,
      trades: a.trades,
      winRate: a.trades > 0 ? new Decimal(a.wins).div(a.trades).mul(HUNDRED).toNumber() : 0,
      profitFactor: a.grossLoss.gt(0) ? a.grossWin.div(a.grossLoss).toNumber() : null,
      expectancy: a.trades > 0 ? a.pnl.div(a.trades).toString() : '0',
    });
  }
  return segments;
}

/** Last close per UTC day from an ascending price series, sorted by day. */
function dailyCloses(prices: readonly PricePoint[]): { day: number; close: Decimal }[] {
  const byDay = new Map<number, Decimal>();
  for (const p of prices) {
    const close = parse(p.close);
    if (close === null) continue;
    byDay.set(dayOf(p.tsMs), close); // ascending input → later write wins = day's last close
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([day, close]) => ({ day, close }));
}

/**
 * Classify each day's regime from the daily closes that had already closed
 * BEFORE it began (`closes[0..i-1]`), so the verdict has no lookahead (only
 * closed daily candles inform it). A day without enough prior history to fill
 * the MA window is left unclassified.
 */
function regimeByDay(daily: readonly { day: number; close: Decimal }[]): Map<number, MarketRegime> {
  const out = new Map<number, MarketRegime>();
  daily.forEach((today, i) => {
    if (i < MA_PERIOD) return; // not enough prior closes to fill the MA window
    const prior = daily.slice(0, i);
    const maWindow = prior.slice(prior.length - MA_PERIOD);
    let acc = ZERO;
    for (const d of maWindow) acc = acc.add(d.close);
    const ma = acc.div(MA_PERIOD);
    const confirm = prior.slice(prior.length - CONFIRM_BARS);
    if (confirm.every((d) => d.close.gt(ma))) out.set(today.day, 'bull');
    else if (confirm.every((d) => d.close.lt(ma))) out.set(today.day, 'bear');
    else out.set(today.day, 'neutral');
  });
  return out;
}

const valued = (points: readonly PricePoint[]): ValuedPoint[] => {
  const out: ValuedPoint[] = [];
  for (const p of points) {
    const value = parse(p.close);
    if (value !== null) out.push({ tsMs: p.tsMs, value });
  }
  return out;
};

/**
 * Apply each step-to-step ratio under the bucket of the later point. Generic
 * over the bucket key so the same compounding drives the regime split (bucket =
 * regime) and the out-of-sample split (bucket = in/out of the holdout window); a
 * step whose later point maps to `undefined` is skipped.
 */
function accumulateSteps<K>(
  points: readonly ValuedPoint[],
  bucketOf: (tsMs: number) => K | undefined,
  apply: (bucket: K, ratio: Decimal) => void,
): void {
  let prev: ValuedPoint | undefined;
  for (const cur of points) {
    if (prev && prev.value.gt(0)) {
      const bucket = bucketOf(cur.tsMs);
      if (bucket !== undefined) apply(bucket, cur.value.div(prev.value));
    }
    prev = cur;
  }
}

/**
 * Fraction of a run's time span held out for out-of-sample validation: the
 * most-recent 30%. A fixed analysis constant, not a strategy or policy input —
 * the engine computes one canonical holdout; the gate decides whether to enforce
 * it. 70/30 is the conventional train/test split; the recent slice is the part an
 * operator tuning against the full window did not target.
 */
export const HOLDOUT_FRACTION = 0.3;

/**
 * Recompute performance over only the most-recent {@link fraction} of the run's
 * time span. Strategy and hold returns compound the equity and benchmark steps
 * that fall in the holdout (mirroring {@link computeRegimeBreakdown}); trades are
 * those that OPENED in the holdout, so the slice answers "did the strategy still
 * earn its edge on data the tuning never saw". Returns `null` when the run is too
 * short to carve a holdout (fewer than two equity points, or a zero-length span).
 */
export function computeHoldoutSegment(
  trades: readonly RegimeTrade[],
  benchmarkPrices: readonly PricePoint[],
  equityCurve: readonly EquityPoint[],
  fraction: number,
): OutOfSampleSegment | null {
  if (equityCurve.length < 2) return null;
  const fromTs = equityCurve[0]?.tsMs ?? 0;
  const toTs = equityCurve[equityCurve.length - 1]?.tsMs ?? 0;
  if (toTs <= fromTs) return null;
  // Cut point in epoch ms: the in-sample/holdout boundary. Timestamp math (what
  // `number` is reserved for, not money); Decimal keeps the multiply exact and
  // avoids the banned `Math.floor`.
  const cut = new Decimal(fromTs)
    .add(new Decimal(toTs - fromTs).mul(1 - fraction))
    .floor()
    .toNumber();
  const inHoldout = (tsMs: number): true | undefined => (tsMs >= cut ? true : undefined);

  let strat = ONE;
  let hold = ONE;
  const equityPoints = valued(equityCurve.map((p) => ({ tsMs: p.tsMs, close: p.equity })));
  accumulateSteps(equityPoints, inHoldout, (_bucket, ratio) => {
    strat = strat.mul(ratio);
  });
  accumulateSteps(valued(benchmarkPrices), inHoldout, (_bucket, ratio) => {
    hold = hold.mul(ratio);
  });

  let count = 0;
  let wins = 0;
  let grossWin = ZERO;
  let grossLoss = ZERO;
  let pnl = ZERO;
  for (const t of trades) {
    if (t.openTsMs < cut) continue;
    count += 1;
    if (t.pnl.gt(0)) {
      wins += 1;
      grossWin = grossWin.add(t.pnl);
    } else if (t.pnl.lt(0)) {
      grossLoss = grossLoss.add(t.pnl.abs());
    }
    pnl = pnl.add(t.pnl);
  }

  const returnPct = strat.sub(ONE).mul(HUNDRED).toNumber();
  const holdReturnPct = hold.sub(ONE).mul(HUNDRED).toNumber();
  return {
    fraction,
    fromMs: cut,
    toMs: toTs,
    returnPct,
    holdReturnPct,
    alphaVsHoldPct: returnPct - holdReturnPct,
    trades: count,
    winRate: count > 0 ? new Decimal(wins).div(count).mul(HUNDRED).toNumber() : 0,
    profitFactor: grossLoss.gt(0) ? grossWin.div(grossLoss).toNumber() : null,
    expectancy: count > 0 ? pnl.div(count).toString() : '0',
  };
}
