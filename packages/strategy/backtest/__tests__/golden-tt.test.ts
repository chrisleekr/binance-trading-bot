import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { Decimal } from '@app/money';
import type { Candle, CandleInterval } from '@app/strategy-core';
import { trailingTrade, type TTConfig } from '@app/strategy-trailing-trade';

import { runBacktest } from '../src/run.js';
import { OhlcvFillModel } from '../src/ohlcv-fill.js';
import { arrayMarketDataSource } from '../src/portfolio-source.js';
import { SYMBOL_INFO } from './_fixtures.js';

// Hermetic golden-fixture gate: the real trailing-trade strategy replayed
// over a committed candle series through the realistic OHLCV fill model.
// Generalizes the strategy "golden-fixture replay diff = 0" quality gate to
// the whole backtest report. The snapshot is committed; CI fails on ANY
// numeric drift (an exact match, stricter than the 1 bps threshold the gate
// task specifies). An intentional engine/strategy change updates the snapshot
// with a rationale, the same discipline as the TT tick replay.
//
// Technicals are opted out (`intervals: []` opens the buy gate fully — the
// documented profile-level opt-out), so the run is hermetic: no live klines,
// no signal computation, just the engine + TT grid/sell/stop-loss logic +
// fills + fill-adoption + metrics. The technicals bundle path is covered by
// the offline-market tests and TT's own gate tests.

const FIXTURE = resolve(__dirname, 'fixtures/golden/tt-btc-1h.jsonl');

function loadCandles(): Candle[] {
  const raw = readFileSync(FIXTURE, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0 && !l.startsWith('#'));
  expect(lines.length).toBeGreaterThan(0); // a truncated fixture must fail loudly
  return lines.map((l) => JSON.parse(l) as Candle);
}

function goldenConfig(): TTConfig {
  return trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '15' },
      avgEntryPriceRemoveThreshold: '0',
    },
    sell: { enabled: true, stopLossPercentage: '0.97', triggerPercentage: '1.05' },
    technicals: { intervals: [] },
  }) as TTConfig;
}

function runGolden(strategy: typeof trailingTrade = trailingTrade) {
  const candles = loadCandles();
  const config = goldenConfig();
  const first = candles[0];
  const last = candles[candles.length - 1];
  if (!first || !last) throw new Error('golden fixture is empty');
  return runBacktest({
    strategy,
    config,
    dataSource: arrayMarketDataSource([
      { symbol: 'BTCUSDT', interval: '1h' as CandleInterval, candles },
    ]),
    fillModel: new OhlcvFillModel({ makerBps: 10, takerBps: 10, slippageBps: 5 }),
    request: {
      symbols: ['BTCUSDT'],
      intervals: ['1h'],
      fromMs: first.openTimeMs,
      toMs: last.closeTimeMs,
    },
    initialBalances: { USDT: '1000' },
    quoteAsset: 'USDT',
    symbolInfos: [SYMBOL_INFO],
    startupCandleCount: 3,
    seed: 42,
    // Technicals opted out → empty signals; 1:1 with empty config.intervals.
    buildBundle: () => ({ technicals: { config: config.technicals, signals: [] }, override: null }),
  });
}

describe('trailingTrade — backtest golden-fixture gate', () => {
  it('replays a real buy/sell/stop-loss cycle and produces non-zero trades + finite Sharpe', async () => {
    const report = await runGolden();
    // Acceptance: a meaningful run, not a degenerate one. The fill-adoption
    // path is what makes this hold — without it TT never sees its position
    // and re-buys every candle.
    expect(report.summary.tradeCount).toBeGreaterThan(0);
    expect(report.trades.some((t) => t.side === 'BUY')).toBe(true);
    expect(report.trades.some((t) => t.side === 'SELL')).toBe(true);
    // Sharpe is null under the small-sample floor (this fixture has few trades),
    // never NaN or Infinity.
    const { sharpe } = report.metrics;
    expect(sharpe === null || Number.isFinite(sharpe)).toBe(true);
  });

  it('matches the committed report snapshot (drift gate)', async () => {
    const report = await runGolden();
    expect(report).toMatchSnapshot();
  });

  // Structural guard on the retry-model invariant the executor's `applyAll` now
  // enforces by throwing: a single tick must emit at most one place-order, else
  // a failed apply's re-emit (the un-advanced state) would re-place an order
  // that already landed. Counting placements per tick over the real corpus is
  // non-vacuous even if the golden fixture is regenerated — it is a count, not a
  // snapshot. A wrapper records each tick's raw decisions before the executor
  // applies them.
  //
  // Covers trailing-trade ONLY: momentum and rebalance have no golden corpus in
  // this package, so their at-most-one-placement rests on branch-exclusivity in
  // their own tick.ts; structural CI coverage for them is tracked as a follow-up.
  // The universal runtime guarantee remains the `applyAll` throw.
  it('never emits more than one place-order in a single tick', async () => {
    const placementsPerTick: number[] = [];
    const recording: typeof trailingTrade = {
      ...trailingTrade,
      tick: (input) => {
        const out = trailingTrade.tick(input);
        placementsPerTick.push(out.decisions.filter((d) => d.type === 'place-order').length);
        return out;
      },
    };
    await runGolden(recording);
    // The corpus must have driven real ticks, or the assertion below is empty.
    expect(placementsPerTick.length).toBeGreaterThan(0);
    expect(Math.max(...placementsPerTick)).toBeLessThanOrEqual(1);
  });

  it('is deterministic: two runs are byte-identical', async () => {
    // TT with technicals opted out never draws from the seeded RNG, so this
    // fixture's determinism is trivially satisfied on the RNG axis; the test
    // still guards the clock, fill-adoption, and metric-computation paths
    // against non-determinism (map ordering, accumulation order).
    const [a, b] = await Promise.all([runGolden(), runGolden()]);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});

// Stop-limit BUY: a grid level configured with stop/limit price percentages
// places a STOP_LOSS_LIMIT buy that rests and fills when a later candle's high
// crosses the stop. Proves the strategy emission integrates with the OHLCV
// fill model end-to-end (the lowest-price first-buy trigger is unit-covered in
// the trailing-trade package).
const stopLimitCandle = (
  i: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Candle => ({
  openTimeMs: i * 3_600_000,
  closeTimeMs: i * 3_600_000 + 3_599_999,
  open: String(open),
  high: String(high),
  low: String(low),
  close: String(close),
  volume: '10',
  isClosed: true,
});

const STOP_LIMIT_CANDLES: Candle[] = [
  stopLimitCandle(0, 100, 100.5, 99.5, 100), // entry fires → STOP_LOSS_LIMIT buy stop 101 / limit 102
  stopLimitCandle(1, 100, 101.5, 100, 101.2), // high 101.5 >= stop 101 (armed); low 100 < limit 102 → fills at the limit 102
  stopLimitCandle(2, 101.2, 110, 101, 108), // close 108 >= 102 x 1.05 (107.1) → arms trailing stop; highSinceBuy 110
  stopLimitCandle(3, 108, 110, 104, 105), // close 105 <= 110 x 0.98 (107.8) → trailing market sell
  stopLimitCandle(4, 105, 106, 104, 105), // market sell fills at the next open
];

function stopLimitConfig(): TTConfig {
  return trailingTrade.configSchema.parse({
    symbol: 'BTCUSDT',
    candleInterval: '1h',
    buy: {
      enabled: true,
      entrySizing: { mode: 'fixed', amount: '50' },
      avgEntryPriceRemoveThreshold: '0',
      firstBuyTriggerBasis: 'immediate',
      gridLevels: [
        {
          triggerPercentage: '1',
          maxPurchaseAmount: '50',
          stopPricePercentage: '1.01',
          limitPricePercentage: '1.02',
        },
      ],
    },
    sell: {
      enabled: true,
      stopLossPercentage: '0.97',
      triggerPercentage: '1.05',
      trailingStopPercentage: '0.98',
    },
    technicals: { intervals: [] },
  }) as TTConfig;
}

function runStopLimit() {
  return runBacktest({
    strategy: trailingTrade,
    config: stopLimitConfig(),
    dataSource: arrayMarketDataSource([
      { symbol: 'BTCUSDT', interval: '1h' as CandleInterval, candles: STOP_LIMIT_CANDLES },
    ]),
    fillModel: new OhlcvFillModel({ makerBps: 10, takerBps: 10, slippageBps: 5 }),
    request: { symbols: ['BTCUSDT'], intervals: ['1h'], fromMs: 0, toMs: Number.MAX_SAFE_INTEGER },
    initialBalances: { USDT: '1000' },
    quoteAsset: 'USDT',
    symbolInfos: [SYMBOL_INFO],
    startupCandleCount: 0,
    seed: 1,
    buildBundle: () => ({
      technicals: { config: stopLimitConfig().technicals, signals: [] },
      override: null,
    }),
  });
}

describe('trailingTrade — stop-limit buy (backtest)', () => {
  it('rests a STOP_LOSS_LIMIT buy and fills it at the limit price', async () => {
    const report = await runStopLimit();
    const buys = report.trades.filter((t) => t.side === 'BUY');
    expect(buys.length).toBeGreaterThanOrEqual(1);
    const first = buys[0];
    if (first === undefined) throw new Error('expected a BUY trade');
    // Candle 1 arms the stop (high 101.5 >= stop 101) and crosses the limit
    // (low 100 < limit 102), so the order fills at its limit — a stop-limit fills
    // at its limit, not the stop, and takes no slippage.
    expect(new Decimal(first.price).equals(new Decimal('102'))).toBe(true);
  });

  it('matches the committed report snapshot (drift gate)', async () => {
    expect(await runStopLimit()).toMatchSnapshot();
  });
});
