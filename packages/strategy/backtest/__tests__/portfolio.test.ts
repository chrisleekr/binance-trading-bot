import { describe, expect, it } from 'vitest';
import type { Candle, CandleInterval, SymbolInfo } from '@app/strategy-core';
import { runBacktest } from '../src/run.js';
import { IdealFillModel } from '../src/ideal-fill.js';
import { arrayMarketDataSource, mergeCandleTicks } from '../src/portfolio-source.js';
import type { SymbolCandles } from '../src/portfolio-source.js';
import { makeBuyOnceStrategy, SYMBOL_INFO } from './_fixtures.js';

const MIN = 60_000;

function oneCandle(closeTimeMs: number, price: string): Candle {
  return {
    openTimeMs: closeTimeMs - MIN + 1,
    closeTimeMs,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: '1',
    isClosed: true,
  };
}

function candlesAt(closeTimes: number[], price: string): Candle[] {
  return closeTimes.map((t) => oneCandle(t, price));
}

const ETH_INFO: SymbolInfo = { ...SYMBOL_INFO, symbol: 'ETHUSDT', baseAsset: 'ETH' };

describe('mergeCandleTicks', () => {
  it('orders ticks by closeTime across symbols with different intervals', () => {
    const btc: SymbolCandles = {
      symbol: 'BTCUSDT',
      interval: '1m' as CandleInterval,
      candles: candlesAt([60_000, 120_000, 180_000], '100'),
    };
    const eth: SymbolCandles = {
      symbol: 'ETHUSDT',
      interval: '5m' as CandleInterval,
      candles: candlesAt([90_000, 300_000], '50'),
    };
    const merged = mergeCandleTicks([btc, eth]);
    expect(merged.map((t) => [t.symbol, t.candle.closeTimeMs])).toEqual([
      ['BTCUSDT', 60_000],
      ['ETHUSDT', 90_000],
      ['BTCUSDT', 120_000],
      ['BTCUSDT', 180_000],
      ['ETHUSDT', 300_000],
    ]);
    // strictly non-decreasing closeTime
    const closes = merged.map((t) => t.candle.closeTimeMs);
    expect(closes).toEqual([...closes].sort((a, b) => a - b));
  });

  it('handles an empty series set', () => {
    expect(mergeCandleTicks([])).toEqual([]);
  });
});

describe('runBacktest — portfolio (shared balance)', () => {
  const baseOpts = {
    request: {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      intervals: ['1m'] as CandleInterval[],
      fromMs: 0,
      toMs: 600_000,
    },
    quoteAsset: 'USDT',
    symbolInfos: [SYMBOL_INFO, ETH_INFO],
  };

  it('a buy on one symbol constrains a later buy on another from the shared quote', async () => {
    // 1000 USDT. BTC closes first (t=60k) and buys 8@100=800; ETH closes later
    // (t=120k) and tries 8@100=800 but only 200 USDT remains → ideal rejects.
    const source = arrayMarketDataSource([
      { symbol: 'BTCUSDT', interval: '1m', candles: candlesAt([60_000], '100') },
      { symbol: 'ETHUSDT', interval: '1m', candles: candlesAt([120_000], '100') },
    ]);
    const report = await runBacktest({
      ...baseOpts,
      strategy: makeBuyOnceStrategy('8'),
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: source,
      initialBalances: { USDT: '1000' },
    });
    // only BTC filled
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0]?.symbol).toBe('BTCUSDT');
    expect(report.perSymbol.find((p) => p.symbol === 'BTCUSDT')?.tradeCount).toBe(1);
    // ETH order was attempted but rejected → no ETH trade
    expect(report.trades.some((t) => t.symbol === 'ETHUSDT')).toBe(false);
  });

  it('both symbols fill when the shared balance covers both; equity reconciles', async () => {
    const source = arrayMarketDataSource([
      { symbol: 'BTCUSDT', interval: '1m', candles: candlesAt([60_000, 180_000], '100') },
      { symbol: 'ETHUSDT', interval: '1m', candles: candlesAt([120_000, 240_000], '50') },
    ]);
    const report = await runBacktest({
      ...baseOpts,
      strategy: makeBuyOnceStrategy('2'),
      config: {},
      fillModel: new IdealFillModel(),
      dataSource: source,
      initialBalances: { USDT: '1000' },
    });
    // BTC: 2@100=200, ETH: 2@50=100 → quote 700, BTC 2 (mark 100), ETH 2 (mark 50)
    // equity = 700 + 2*100 + 2*50 = 1000 (flat prices, no fee)
    expect(report.trades).toHaveLength(2);
    expect(report.summary.finalBalance).toBe('1000');
    expect(report.summary.totalReturnPct).toBe(0);
    const last = report.equityCurve.at(-1);
    expect(last?.equity).toBe('1000');
    expect(report.perSymbol.map((p) => p.symbol).sort()).toEqual(['BTCUSDT', 'ETHUSDT']);
  });

  it('throws loudly on an out-of-order (unmerged) source', async () => {
    // A source that yields ETH@120k then BTC@60k violates the ordering contract.
    const badSource = {
      stream() {
        async function* gen() {
          yield {
            kind: 'candle-close' as const,
            symbol: 'ETHUSDT',
            interval: '1m' as CandleInterval,
            candle: oneCandle(120_000, '50'),
          };
          yield {
            kind: 'candle-close' as const,
            symbol: 'BTCUSDT',
            interval: '1m' as CandleInterval,
            candle: oneCandle(60_000, '100'),
          };
        }
        return gen();
      },
    };
    await expect(
      runBacktest({
        ...baseOpts,
        strategy: makeBuyOnceStrategy('1'),
        config: {},
        fillModel: new IdealFillModel(),
        dataSource: badSource,
        initialBalances: { USDT: '1000' },
      }),
    ).rejects.toThrow(/out of order/);
  });

  it('is deterministic for the same portfolio inputs and seed', async () => {
    const make = () =>
      runBacktest({
        ...baseOpts,
        strategy: makeBuyOnceStrategy('2'),
        config: {},
        fillModel: new IdealFillModel(),
        dataSource: arrayMarketDataSource([
          { symbol: 'BTCUSDT', interval: '1m', candles: candlesAt([60_000, 180_000], '100') },
          { symbol: 'ETHUSDT', interval: '1m', candles: candlesAt([120_000], '50') },
        ]),
        initialBalances: { USDT: '1000' },
        seed: 99,
      });
    const [a, b] = await Promise.all([make(), make()]);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
