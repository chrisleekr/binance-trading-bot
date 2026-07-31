import { describe, expect, it } from 'vitest';
import { runBacktest } from '../src/run.js';
import { IdealFillModel } from '../src/ideal-fill.js';
import type { MarketDataSource, MarketTick } from '../src/types.js';
import {
  buyOnceStrategy,
  candleSource,
  flatCandles,
  idleStrategy,
  singleCandle,
  SYMBOL,
  SYMBOL_INFO,
} from './_fixtures.js';

const baseOpts = {
  request: { symbols: [SYMBOL], intervals: ['1m'] as const, fromMs: 0, toMs: 600_000 },
  initialBalances: { USDT: '1000' },
  quoteAsset: 'USDT',
  symbolInfos: [SYMBOL_INFO],
};

describe('runBacktest — smoke', () => {
  it('idle strategy on a flat market produces zero trades and zero equity drift', async () => {
    const report = await runBacktest({
      ...baseOpts,
      strategy: idleStrategy,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(10, '100')),
    });
    expect(report.summary.tradeCount).toBe(0);
    expect(report.summary.totalReturnPct).toBe(0);
    expect(report.summary.startingBalance).toBe('1000');
    expect(report.summary.finalBalance).toBe('1000');
    expect(report.equityCurve).toHaveLength(10);
  });

  it('warm-up suppresses ticks for the first N candles', async () => {
    const report = await runBacktest({
      ...baseOpts,
      strategy: idleStrategy,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(10, '100')),
      startupCandleCount: 4,
    });
    // 10 candles, 4 consumed for warm-up → 6 ticks → 6 equity points
    expect(report.equityCurve).toHaveLength(6);
  });
});

describe('runBacktest — benchmarks (buy-and-hold, DCA, alpha)', () => {
  it('computes hold and DCA benchmarks and alpha from the close series', async () => {
    // Closes 100 → 150 with an idle strategy (no trades, 0% return).
    // Buy & hold = (150 - 100) / 100 = +50%.
    // DCA = lastClose * mean(1/close) - 1 = 150 * ((1/100 + 1/150) / 2) - 1
    //     = 150 * 0.008333… - 1 = 1.25 - 1 = +25%.
    const candles = [...flatCandles(1, '100', 0), ...flatCandles(1, '150', 60_000)];
    const report = await runBacktest({
      ...baseOpts,
      strategy: idleStrategy,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(candles),
    });
    expect(report.metrics.totalReturnPct).toBe(0);
    expect(report.metrics.marketChangePct).toBeCloseTo(50, 6);
    expect(report.metrics.dcaChangePct).toBeCloseTo(25, 6);
    // Idle strategy underperforms both passive benchmarks → negative alpha.
    expect(report.metrics.alphaVsHoldPct).toBeCloseTo(-50, 6);
    expect(report.metrics.alphaVsDcaPct).toBeCloseTo(-25, 6);
  });

  it('anchors the hold/DCA benchmark on the first traded candle, excluding warmup (#534)', async () => {
    // 2 warmup candles at 50, then a 100 → 120 trading window. The hold
    // benchmark must measure the window only (100 → 120 = +20%), NOT the
    // warmup-to-window jump (50 → 120 = +140%). A regression here means the
    // benchmark accumulators are running before the warm-up guard again.
    const candles = [
      ...flatCandles(2, '50', 0),
      ...flatCandles(1, '100', 120_000),
      ...flatCandles(1, '120', 180_000),
    ];
    const report = await runBacktest({
      ...baseOpts,
      strategy: idleStrategy,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(candles),
      startupCandleCount: 2,
    });
    expect(report.metrics.marketChangePct).toBeCloseTo(20, 6);
    expect(report.metrics.marketChangePct).not.toBeCloseTo(140, 6);
    // DCA over the window closes only: 120 * mean(1/100, 1/120) - 1 = +10%.
    expect(report.metrics.dcaChangePct).toBeCloseTo(10, 6);
    expect(report.metrics.alphaVsHoldPct).toBeCloseTo(-20, 6);
    expect(report.equityCurve).toHaveLength(2);
  });

  it('reports zero benchmarks for a run with no priced candle', async () => {
    const report = await runBacktest({
      ...baseOpts,
      strategy: idleStrategy,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource([]),
    });
    expect(report.metrics.marketChangePct).toBe(0);
    expect(report.metrics.dcaChangePct).toBe(0);
    expect(report.metrics.alphaVsHoldPct).toBe(0);
    expect(report.metrics.alphaVsDcaPct).toBe(0);
  });
});

describe('runBacktest — trading', () => {
  it('buy-once strategy buys at market and holds; equity reflects the position', async () => {
    const report = await runBacktest({
      ...baseOpts,
      strategy: buyOnceStrategy,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(5, '100')),
    });
    expect(report.summary.tradeCount).toBe(1);
    expect(report.trades[0]).toMatchObject({ side: 'BUY', qty: '0.01', price: '100' });
    // flat price → equity unchanged (no fees in the ideal model)
    expect(report.summary.totalReturnPct).toBe(0);
  });

  it('a price rise after the buy shows positive return', async () => {
    // 1 candle at 100 (buy fires), then 4 at 110
    const candles = [...flatCandles(1, '100', 0), ...flatCandles(4, '110', 60_000)];
    const report = await runBacktest({
      ...baseOpts,
      strategy: buyOnceStrategy,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(candles),
    });
    // bought 0.01 BTC @100 = 1 USDT spent; 0.01 BTC now @110 = 1.1 → +0.1 on 1000 = 0.01%
    expect(report.summary.totalReturnPct).toBeCloseTo(0.01, 6);
  });
});

describe('runBacktest — auxiliary windows', () => {
  it('merges auxiliary interval windows into the snapshot, the streamed interval winning', async () => {
    const seenKeys: string[][] = [];
    const probe: typeof idleStrategy = {
      ...idleStrategy,
      tick: (input) => {
        seenKeys.push(Object.keys(input.market.candlesByInterval));
        return { nextState: input.state, decisions: [], logs: [], metrics: [] };
      },
    };
    const daily = flatCandles(2, '100');
    await runBacktest({
      ...baseOpts,
      strategy: probe,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(3, '100')),
      auxiliaryWindows: () => ({ '1d': daily }),
    });
    expect(seenKeys.length).toBeGreaterThan(0);
    // Both the streamed trading interval and the injected daily window are visible.
    expect(seenKeys[0]).toEqual(expect.arrayContaining(['1m', '1d']));
  });
});

describe('runBacktest — account overlay (reserve floor)', () => {
  it('applies adjustAccount to the account view the strategy sees each tick', async () => {
    const seenBtcFree: string[] = [];
    const probe: typeof idleStrategy = {
      ...idleStrategy,
      tick: (input) => {
        seenBtcFree.push(input.account.balances['BTC']?.free.toString() ?? 'none');
        return { nextState: input.state, decisions: [], logs: [], metrics: [] };
      },
    };
    await runBacktest({
      ...baseOpts,
      initialBalances: { USDT: '1000', BTC: '10' },
      strategy: probe,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(3, '100')),
      // Reserve 4 BTC: the strategy must see 10 − 4 = 6 free base every tick.
      adjustAccount: (account, symbol) => {
        expect(symbol).toBe(SYMBOL);
        const bal = account.balances['BTC'];
        if (!bal) return account;
        return {
          ...account,
          balances: { ...account.balances, BTC: { ...bal, free: bal.free.sub(4) } },
        };
      },
    });
    expect(seenBtcFree.length).toBeGreaterThan(0);
    expect(seenBtcFree.every((v) => v === '6')).toBe(true);
  });

  it('leaves the account byte-identical when no overlay is passed', async () => {
    const seen: string[] = [];
    const probe: typeof idleStrategy = {
      ...idleStrategy,
      tick: (input) => {
        seen.push(input.account.balances['BTC']?.free.toString() ?? 'none');
        return { nextState: input.state, decisions: [], logs: [], metrics: [] };
      },
    };
    await runBacktest({
      ...baseOpts,
      initialBalances: { USDT: '1000', BTC: '10' },
      strategy: probe,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(2, '100')),
    });
    expect(seen.every((v) => v === '10')).toBe(true);
  });
});

describe('runBacktest — indicator snapshots', () => {
  it('populates market.indicatorsByInterval each tick so an armed indicatorGate can read it', async () => {
    // Regression for the #534 audit: the engine never set indicatorsByInterval,
    // so an armed RSI/SMA/EMA gate failed closed with `indicator-unavailable`
    // on every tick and the profile could never trade in a backtest.
    const snaps: (Record<string, unknown> | undefined)[] = [];
    const probe: typeof idleStrategy = {
      ...idleStrategy,
      tick: (input) => {
        snaps.push(input.market.indicatorsByInterval?.['1m']);
        return { nextState: input.state, decisions: [], logs: [], metrics: [] };
      },
    };
    await runBacktest({
      ...baseOpts,
      strategy: probe,
      config: {},
      fillModel: new IdealFillModel(),
      // 25 flat candles: the last tick's window is long enough for SMA/EMA-20.
      dataSource: candleSource(flatCandles(25, '100')),
    });
    expect(snaps.length).toBe(25);
    // First tick: window length 1, shorter than any indicator period → fields null.
    expect(snaps[0]).toMatchObject({ sma20: null, ema20: null, rsi14: null });
    // Last tick: a full window → the live-parity SMA/EMA-20 are present.
    expect(snaps[24]).toMatchObject({ sma20: '100', ema20: '100' });
  });
});

describe('runBacktest — opening balance & preconditions', () => {
  it('values a non-quote opening balance at the first candle price', async () => {
    const report = await runBacktest({
      ...baseOpts,
      strategy: idleStrategy,
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: candleSource(flatCandles(3, '100')),
      initialBalances: { USDT: '1000', BTC: '1' }, // 1 BTC @100 = 100
    });
    expect(report.summary.startingBalance).toBe('1100');
    expect(report.summary.finalBalance).toBe('1100');
  });

  it('throws when a symbol streams two intervals', async () => {
    const mixed: MarketDataSource = {
      stream(): AsyncIterable<MarketTick> {
        async function* gen(): AsyncGenerator<MarketTick> {
          yield {
            kind: 'candle-close',
            symbol: SYMBOL,
            interval: '1m',
            candle: singleCandle('100', 0),
          };
          yield {
            kind: 'candle-close',
            symbol: SYMBOL,
            interval: '1h',
            candle: singleCandle('100', 60_000),
          };
        }
        return gen();
      },
    };
    await expect(
      runBacktest({
        ...baseOpts,
        strategy: idleStrategy,
        config: {},
        fillModel: new IdealFillModel(),
        dataSource: mixed,
      }),
    ).rejects.toThrow(/exactly one interval per symbol/);
  });
});

describe('runBacktest — determinism', () => {
  it('same (strategy, data, fillModel, seed) yields a byte-identical report', async () => {
    const make = () =>
      runBacktest({
        ...baseOpts,
        strategy: buyOnceStrategy,
        config: {},
        fillModel: new IdealFillModel(),
        dataSource: candleSource(flatCandles(8, '100')),
        seed: 12345,
      });
    const [a, b] = await Promise.all([make(), make()]);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
