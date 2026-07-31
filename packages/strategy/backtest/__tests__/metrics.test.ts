import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import { computeMetrics } from '../src/metrics.js';
import type { BacktestTrade, EquityPoint } from '../src/types.js';

const DAY = 86_400_000;

function eq(points: [number, string][]): EquityPoint[] {
  return points.map(([tsMs, equity]) => ({ tsMs, equity }));
}

const trade = (
  side: 'BUY' | 'SELL',
  price: string,
  qty: string,
  tsMs: number,
  feeQuote = '0',
  symbol = 'BTCUSDT',
): BacktestTrade => ({ symbol, side, reason: 'manual', price, qty, feeQuote, tsMs });

describe('computeMetrics — returns & balances', () => {
  it('computes total return and absolute profit from the equity curve', () => {
    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [DAY, '1100'],
      ]),
      trades: [],
      startingBalance: new Decimal('1000'),
      marketChangePct: 8,
      dcaChangePct: 6,
    });
    expect(metrics.startingBalance).toBe('1000');
    expect(metrics.finalBalance).toBe('1100');
    expect(metrics.absoluteProfit).toBe('100');
    expect(metrics.totalReturnPct).toBeCloseTo(10, 6);
    expect(metrics.marketChangePct).toBe(8);
    expect(metrics.dcaChangePct).toBe(6);
    // Alpha = total return minus the passive benchmark over the same range.
    expect(metrics.alphaVsHoldPct).toBeCloseTo(2, 6);
    expect(metrics.alphaVsDcaPct).toBeCloseTo(4, 6);
  });

  it('reports negative alpha when the strategy underperforms the benchmark', () => {
    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [DAY, '1050'],
      ]),
      trades: [],
      startingBalance: new Decimal('1000'),
      marketChangePct: 20,
      dcaChangePct: 12,
    });
    // +5% return while the basket rose 20%: holding beat the strategy.
    expect(metrics.totalReturnPct).toBeCloseTo(5, 6);
    expect(metrics.alphaVsHoldPct).toBeCloseTo(-15, 6);
    expect(metrics.alphaVsDcaPct).toBeCloseTo(-7, 6);
  });

  it('is all-zero / null-safe for an empty run (no NaN, no Infinity)', () => {
    const { metrics, drawdownSeries, perSymbol } = computeMetrics({
      equityCurve: [],
      trades: [],
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.totalReturnPct).toBe(0);
    expect(metrics.cagrPct).toBe(0);
    // No trades → the risk ratios are undefined, reported null (not a bogus 0).
    expect(metrics.sharpe).toBeNull();
    expect(metrics.sortino).toBeNull();
    expect(metrics.calmar).toBe(0);
    expect(metrics.sqn).toBeNull();
    expect(metrics.maxDrawdownPct).toBe(0);
    expect(metrics.totalTrades).toBe(0);
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.bestTradePct).toBeNull();
    expect(metrics.worstTradePct).toBeNull();
    expect(metrics.avgTradeDurationMs).toBeNull();
    expect(metrics.finalBalance).toBe('1000');
    expect(drawdownSeries).toEqual([]);
    expect(perSymbol).toEqual([]);
    // The numeric metrics stay finite (no NaN / Infinity); the ratios are null.
    for (const v of [metrics.cagrPct, metrics.calmar]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe('computeMetrics — CAGR finiteness', () => {
  it('returns 0 (not Infinity) for a profitable sub-day run', () => {
    // 30% gain over 2 hours — annualizing would overflow; must stay finite
    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [2 * 3_600_000, '1300'],
      ]),
      trades: [],
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.cagrPct).toBe(0);
    expect(Number.isFinite(metrics.cagrPct)).toBe(true);
    expect(Number.isFinite(metrics.calmar)).toBe(true);
  });

  it('returns 0 (not Infinity) for a just-over-one-day run with an extreme gain', () => {
    // 10x over ~1.01 days: annualizes to a finite Decimal that overflows
    // IEEE-754 at toNumber() — the number-level guard must catch it.
    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [87_264_000, '10000'], // ~1.01 days in ms
      ]),
      trades: [],
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(Number.isFinite(metrics.cagrPct)).toBe(true);
    expect(metrics.cagrPct).toBe(0);
    expect(Number.isFinite(metrics.calmar)).toBe(true);
  });

  it('computes a finite CAGR only past the annualization floor (>= 90 days)', () => {
    // Below 90 days CAGR is 0 (annualizing a short run is meaningless); a 120-day
    // run clears the floor and annualizes to a sane, finite figure.
    const short = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [30 * DAY, '1100'],
      ]),
      trades: [],
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(short.metrics.cagrPct).toBe(0);

    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [120 * DAY, '1100'],
      ]),
      trades: [],
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.cagrPct).toBeGreaterThan(0);
    expect(metrics.cagrPct).toBeLessThan(100); // sane, not an annualized explosion
    expect(Number.isFinite(metrics.cagrPct)).toBe(true);
  });
});

describe('computeMetrics — drawdown', () => {
  it('finds the worst peak-to-trough and the underwater series', () => {
    // peak 1200 at t1, trough 900 at t3 → -25%, absolute 300
    const { metrics, drawdownSeries } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [1, '1200'],
        [2, '1000'],
        [3, '900'],
        [4, '1100'],
      ]),
      trades: [],
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.maxDrawdownPct).toBeCloseTo(-25, 6);
    expect(metrics.absoluteDrawdown).toBe('300');
    expect(metrics.drawdownStartMs).toBe(1); // the 1200 peak
    expect(metrics.drawdownEndMs).toBe(3); // the 900 trough
    expect(drawdownSeries).toHaveLength(5);
    expect(drawdownSeries[0]?.ddPct).toBe(0);
    expect(drawdownSeries[3]?.ddPct).toBeCloseTo(-25, 6);
  });
});

describe('computeMetrics — trade stats', () => {
  // Two round trips: buy 1@100, sell 1@110 (win +10); buy 1@100, sell 1@90 (loss -10)
  const trades = [
    trade('BUY', '100', '1', 0),
    trade('SELL', '110', '1', DAY),
    trade('BUY', '100', '1', 2 * DAY),
    trade('SELL', '90', '1', 3 * DAY),
  ];

  it('pairs fills into round trips and computes win/loss aggregates', () => {
    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [3 * DAY, '1000'],
      ]),
      trades,
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.totalTrades).toBe(2);
    expect(metrics.wins).toBe(1);
    expect(metrics.losses).toBe(1);
    expect(metrics.winRate).toBeCloseTo(50, 6);
    expect(metrics.profitFactor).toBeCloseTo(1, 6); // gross win 10 / gross loss 10
    expect(metrics.expectancy).toBe('0'); // (+10 -10)/2
    expect(metrics.bestTradePct).toBeCloseTo(10, 6); // +10/100
    expect(metrics.worstTradePct).toBeCloseTo(-10, 6); // -10/100
    expect(metrics.avgTradeDurationMs).toBe(DAY); // each trip lasted one day
  });

  it('profitFactor is null when there are no losing trades', () => {
    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [DAY, '1010'],
      ]),
      trades: [trade('BUY', '100', '1', 0), trade('SELL', '110', '1', DAY)],
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.losses).toBe(0);
    expect(metrics.profitFactor).toBeNull();
    expect(metrics.wins).toBe(1);
  });

  it('average-cost accounting across a grid (two buys, one sell)', () => {
    // buy 1@100, buy 1@200 → avg cost 150; sell 2@180 → pnl (180-150)*2 = 60
    const { metrics, perSymbol } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [DAY, '1060'],
      ]),
      trades: [
        trade('BUY', '100', '1', 0),
        trade('BUY', '200', '1', 1),
        trade('SELL', '180', '2', DAY),
      ],
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.totalTrades).toBe(1);
    expect(metrics.expectancy).toBe('60');
    expect(perSymbol).toEqual([{ symbol: 'BTCUSDT', tradeCount: 3, pnlQuote: '60' }]);
  });

  it('folds fees into realised P&L', () => {
    // buy 1@100 fee 1 (cost 101); sell 1@110 fee 1 (proceeds 109) → pnl 8
    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [DAY, '1008'],
      ]),
      trades: [trade('BUY', '100', '1', 0, '1'), trade('SELL', '110', '1', DAY, '1')],
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.expectancy).toBe('8');
  });
});

describe('computeMetrics — risk ratios', () => {
  it('sharpe is positive for consistently winning trades and finite', () => {
    // Needs >= MIN_RATIO_TRADES (10) closed trades for a non-null ratio: fewer
    // is statistical noise, reported null.
    const trades: BacktestTrade[] = [];
    for (let i = 0; i < 12; i++) {
      trades.push(trade('BUY', '100', '1', i * 2 * DAY));
      trades.push(trade('SELL', '105', '1', (i * 2 + 1) * DAY)); // +5% each
    }
    // introduce variance so std != 0
    trades[1] = trade('SELL', '108', '1', DAY);
    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [24 * DAY, '1600'],
      ]),
      trades,
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.sharpe).toBeGreaterThan(0);
    expect(Number.isFinite(metrics.sharpe)).toBe(true);
    expect(metrics.sqn).toBeGreaterThan(0);
  });

  it('sharpe/sortino are null (not 0) when all trade returns are identical (zero variance)', () => {
    // 10 identical +10% round-trips: past the sample floor, but zero variance and
    // zero downside make both ratios undefined — reported null, not a bogus 0
    // that would read as the WORST config.
    const trades: BacktestTrade[] = [];
    for (let i = 0; i < 10; i++) {
      trades.push(trade('BUY', '100', '1', i * 2 * DAY));
      trades.push(trade('SELL', '110', '1', (i * 2 + 1) * DAY));
    }
    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [20 * DAY, '1100'],
      ]),
      trades,
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.sharpe).toBeNull();
    expect(metrics.sortino).toBeNull();
  });

  it('sortino is null (no downside) while sharpe stays finite for an all-winners run with variance', () => {
    // 10 winning trades of VARYING size: return variance is positive (Sharpe is
    // defined) but there are zero losing trades, so downside deviation is 0 and
    // Sortino is undefined → null, not 0. SQN stays finite like Sharpe.
    const closes = ['104', '106', '103', '108', '105', '107', '102', '109', '104', '106'];
    const trades: BacktestTrade[] = [];
    closes.forEach((c, i) => {
      trades.push(trade('BUY', '100', '1', i * 2 * DAY));
      trades.push(trade('SELL', c, '1', (i * 2 + 1) * DAY));
    });
    const { metrics } = computeMetrics({
      equityCurve: eq([
        [0, '1000'],
        [20 * DAY, '1150'],
      ]),
      trades,
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(metrics.sortino).toBeNull();
    expect(metrics.sharpe).not.toBeNull();
    expect(Number.isFinite(metrics.sharpe)).toBe(true);
    expect(Number.isFinite(metrics.sqn)).toBe(true);
  });
});

describe('computeMetrics — round-trips', () => {
  const flatEquity = eq([
    [0, '1000'],
    [DAY, '1008'],
  ]);

  it('emits one round-trip per reducing sell with entry/exit/fee/reason', () => {
    const { roundTrips, metrics } = computeMetrics({
      // buy 1 @ 100 (fee 1), sell 1 @ 110 (fee 1): cost basis incl fee = 101,
      // proceeds = 109, pnl = 8. Entry price is the fee-free average (100); the
      // attributed fee is the buy fee folded into cost (1) plus the sell fee (1).
      trades: [trade('BUY', '100', '1', 0, '1'), trade('SELL', '110', '1', DAY, '1')],
      equityCurve: flatEquity,
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(roundTrips).toHaveLength(1);
    expect(metrics.totalTrades).toBe(1); // headline trade count == round-trips
    const rt = roundTrips[0];
    if (!rt) throw new Error('expected a round-trip');
    expect(rt.entryPrice).toBe('100');
    expect(rt.exitPrice).toBe('110');
    expect(rt.qty).toBe('1');
    expect(rt.pnlQuote).toBe('8');
    expect(rt.feeQuote).toBe('2');
    expect(rt.returnPct).toBeCloseTo(7.920792, 5); // 8 / 101
    expect(rt.exitReason).toBe('manual');
    expect(rt.openTsMs).toBe(0);
    expect(rt.closeTsMs).toBe(DAY);
    expect(rt.durationMs).toBe(DAY);
  });

  it('stacks grid buys into one average-cost round-trip on the closing sell', () => {
    const { roundTrips } = computeMetrics({
      // two buys (1 @ 100, 1 @ 200) then sell all 2 @ 200: avg entry 150, pnl 100.
      trades: [
        trade('BUY', '100', '1', 0),
        trade('BUY', '200', '1', DAY),
        trade('SELL', '200', '2', 2 * DAY),
      ],
      equityCurve: flatEquity,
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(roundTrips).toHaveLength(1);
    const rt = roundTrips[0];
    if (!rt) throw new Error('expected a round-trip');
    expect(rt.entryPrice).toBe('150');
    expect(rt.qty).toBe('2');
    expect(rt.exitPrice).toBe('200');
    expect(rt.pnlQuote).toBe('100');
    expect(rt.openTsMs).toBe(0); // anchored to the first buy of the lot
  });

  it('closes only the sold portion on a partial sell, leaving the rest open', () => {
    const { roundTrips } = computeMetrics({
      // buy 1 @ 100, sell 0.5 @ 100: one round-trip of qty 0.5, break-even.
      trades: [trade('BUY', '100', '1', 0), trade('SELL', '100', '0.5', DAY)],
      equityCurve: flatEquity,
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(roundTrips).toHaveLength(1);
    const rt = roundTrips[0];
    if (!rt) throw new Error('expected a round-trip');
    expect(rt.qty).toBe('0.5');
    expect(rt.entryPrice).toBe('100');
    expect(rt.pnlQuote).toBe('0');
  });

  it('splits a buy fee pro-rata across partial closes of the same lot', () => {
    const { roundTrips } = computeMetrics({
      // buy 1 @ 100 with a buy fee of 2, then two half-sells each with a 1 sell fee.
      // Each closed half carries HALF the buy fee (1) plus its own sell fee (1) = 2.
      trades: [
        trade('BUY', '100', '1', 0, '2'),
        trade('SELL', '110', '0.5', DAY, '1'),
        trade('SELL', '100', '0.5', 2 * DAY, '1'),
      ],
      equityCurve: flatEquity,
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(roundTrips).toHaveLength(2);
    const [first, second] = roundTrips;
    if (!first || !second) throw new Error('expected two round-trips');
    // Allocated buy-fee share (1) + sell fee (1) on each half.
    expect(first.feeQuote).toBe('2');
    expect(second.feeQuote).toBe('2');
    expect(first.qty).toBe('0.5');
    expect(second.qty).toBe('0.5');
    // Sold at 110 (cost basis 102/unit incl. fee): proceeds 54, cost 51 → +3.
    expect(first.pnlQuote).toBe('3');
    // Sold at 100: proceeds 49, cost 51 → -2.
    expect(second.pnlQuote).toBe('-2');
  });

  it('is empty for a run that never closed a position', () => {
    const { roundTrips } = computeMetrics({
      trades: [trade('BUY', '100', '1', 0)],
      equityCurve: flatEquity,
      startingBalance: new Decimal('1000'),
      marketChangePct: 0,
      dcaChangePct: 0,
    });
    expect(roundTrips).toHaveLength(0);
  });
});
