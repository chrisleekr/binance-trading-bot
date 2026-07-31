import type { Candle } from '@app/strategy-core';
import Decimal from 'decimal.js';
import { runDiscovery } from './run.js';
import type { CurrentAutoSymbol, DiscoveryConfig, DiscoveryTicker } from './types.js';

/**
 * One time-step of market data for the discovery backtest. The harness replays
 * these in order, and at each step the chain sees ONLY this step's snapshot —
 * so the backtest is look-ahead-safe and survivorship-safe by construction (the
 * tradable universe at step t is exactly `tickers`, never the symbols that
 * survive to the end of the window). This is the control Freqtrade enforces by
 * disabling its volume/percent pairlists in backtest.
 */
export interface DiscoveryBacktestStep {
  readonly tickers: readonly DiscoveryTicker[];
  readonly klinesBySymbol: Readonly<Record<string, readonly Candle[]>>;
  readonly nowMs: number;
}

/** Round-trip trading-cost model. `feeRate` is the per-side taker fee (e.g. '0.001' = 0.1%). */
export interface DiscoveryCostModel {
  readonly feeRate: string;
}

/**
 * Net-edge result over the replayed window. `grossReturn`/`netReturn` are the
 * SUM of per-rotation fractional edges (each `(exit - entry) / entry`), NOT a
 * compounded or position-weighted portfolio return — a +5% then +5% rotation
 * sums to 0.10, not the compounded 0.1025. Use `meanEdge` (= `netReturn /
 * trades`) for the average per-rotation edge, which guards against a single
 * outlier flipping the summed gate positive. `netReturn = grossReturn -
 * totalCost`; `netPositive` is the gate: did the rotations' price moves clear
 * round-trip fees + spread. Positions still open at the window's end, or removed
 * after the symbol vanished (no exit price), are NOT counted.
 */
export interface DiscoveryBacktestResult {
  readonly trades: number;
  readonly grossReturn: string;
  readonly totalCost: string;
  readonly netReturn: string;
  /** Average per-rotation net edge (`netReturn / trades`, '0' when no trades). */
  readonly meanEdge: string;
  readonly netPositive: boolean;
}

/** Spread as a fraction of mid: (ask - bid) / mid. A non-positive/crossed book contributes 0. */
const spreadFraction = (t: DiscoveryTicker): Decimal => {
  const bid = new Decimal(t.bidPrice);
  const ask = new Decimal(t.askPrice);
  if (bid.lte(0) || ask.lte(0) || ask.lt(bid)) return new Decimal(0);
  return ask.minus(bid).div(ask.plus(bid).div(2));
};

// Internal auto-set entry carrying the open-position data. Structurally a
// CurrentAutoSymbol (extra fields ignored), so it feeds runDiscovery directly.
interface OpenAuto extends CurrentAutoSymbol {
  readonly entryPrice: Decimal;
  readonly entrySpread: Decimal;
}

/**
 * Replay the discovery chain over a market-data window and measure whether the
 * rotation's realized price moves clear round-trip costs (2 x fee + entry spread
 * + exit spread). The harness threads the discovery state forward exactly as the
 * live cron does, opening a position when the chain adds a symbol (at that step's
 * `lastPrice`) and closing it when the chain removes it while still listed. Pure
 * + deterministic: no `Date`/`Math.random`.
 */
export const backtestDiscovery = (
  steps: readonly DiscoveryBacktestStep[],
  config: DiscoveryConfig,
  cost: DiscoveryCostModel,
): DiscoveryBacktestResult => {
  const fee = new Decimal(cost.feeRate);
  let currentAuto: OpenAuto[] = [];
  const lastFlattenAtMsBySymbol: Record<string, number> = {};

  let grossReturn = new Decimal(0);
  let totalCost = new Decimal(0);
  let trades = 0;

  for (const step of steps) {
    const diff = runDiscovery({
      tickers: step.tickers,
      klinesBySymbol: step.klinesBySymbol,
      currentAuto,
      lastFlattenAtMsBySymbol,
      config,
      nowMs: step.nowMs,
    });
    const tickerBySymbol = new Map(step.tickers.map((t) => [t.symbol, t]));

    // Open every add at its listed price (adds always come from this step's
    // shortlist, so the ticker is present).
    const addSet = new Set(diff.add);
    for (const t of step.tickers) {
      if (!addSet.has(t.symbol)) continue;
      currentAuto = [
        ...currentAuto,
        {
          symbol: t.symbol,
          addedAtMs: step.nowMs,
          entryPrice: new Decimal(t.lastPrice),
          entrySpread: spreadFraction(t),
        },
      ];
    }

    // Close every removed position. Iterating the auto-set (not diff.remove)
    // gives the entry data directly, so there is no separate position lookup.
    const removeSet = new Set(diff.remove);
    for (const pos of currentAuto) {
      if (!removeSet.has(pos.symbol)) continue;
      // Stamp the cooldown on EVERY removal (before the exit-price check),
      // matching the live cron, which stamps last-flatten on every successful
      // reap — including a faded symbol that has vanished from the ticker feed.
      lastFlattenAtMsBySymbol[pos.symbol] = step.nowMs;
      const t = tickerBySymbol.get(pos.symbol);
      if (t === undefined) continue; // vanished from the universe — no exit price
      const exit = new Decimal(t.lastPrice);
      grossReturn = grossReturn.plus(exit.minus(pos.entryPrice).div(pos.entryPrice));
      totalCost = totalCost.plus(fee.times(2)).plus(pos.entrySpread).plus(spreadFraction(t));
      trades += 1;
    }
    currentAuto = currentAuto.filter((c) => !removeSet.has(c.symbol));
  }

  const netReturn = grossReturn.minus(totalCost);
  const meanEdge = trades > 0 ? netReturn.div(trades) : new Decimal(0);
  return {
    trades,
    grossReturn: grossReturn.toString(),
    totalCost: totalCost.toString(),
    netReturn: netReturn.toString(),
    meanEdge: meanEdge.toString(),
    netPositive: netReturn.gt(0),
  };
};
