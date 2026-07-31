import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';
import type { SymbolCandles } from '@app/strategy-backtest';
import { buildTickSeries, tradeableTickCount } from '../../src/backtest/backtest-runner.js';

const HOUR = 3_600_000;
const FIVE_MIN = 300_000;

function candle(openTimeMs: number, durMs: number): Candle {
  return {
    openTimeMs,
    closeTimeMs: openTimeMs + durMs - 1,
    open: '100',
    high: '100',
    low: '100',
    close: '100',
    volume: '1',
    isClosed: true,
  };
}

describe('buildTickSeries', () => {
  it('attaches the finer detail series when detailInterval differs from strategyInterval', () => {
    const byKey = new Map<string, Candle[]>([
      ['BTCUSDT|1h', [candle(0, HOUR)]],
      ['BTCUSDT|5m', [candle(0, FIVE_MIN), candle(FIVE_MIN, FIVE_MIN)]],
    ]);
    const out = buildTickSeries(['BTCUSDT'], byKey, '1h', '5m');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: 'BTCUSDT', interval: '1h' });
    expect(out[0]?.candles).toHaveLength(1);
    expect(out[0]?.detailCandles).toHaveLength(2);
  });

  it('omits detailCandles when detailInterval equals strategyInterval (no finer fidelity)', () => {
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', [candle(0, HOUR)]]]);
    const out = buildTickSeries(['BTCUSDT'], byKey, '1h', '1h');
    expect(out[0]?.candles).toHaveLength(1);
    expect(out[0]?.detailCandles).toBeUndefined();
  });

  it('omits detailCandles when the detail series was not loaded', () => {
    const byKey = new Map<string, Candle[]>([['BTCUSDT|1h', [candle(0, HOUR)]]]);
    const out = buildTickSeries(['BTCUSDT'], byKey, '1h', '5m');
    expect(out[0]?.detailCandles).toBeUndefined();
  });

  it('yields an empty coarse series for a symbol with no loaded candles', () => {
    const out = buildTickSeries(['BTCUSDT'], new Map(), '1h', '5m');
    expect(out[0]?.candles).toEqual([]);
  });
});

describe('tradeableTickCount', () => {
  const series = (...lengths: number[]): SymbolCandles[] =>
    lengths.map((len, i) => ({
      symbol: `S${i}`,
      interval: '1h',
      candles: Array.from({ length: len }, (_, k) => candle(k * HOUR, HOUR)),
    }));

  it('subtracts the warm-up window per symbol', () => {
    // 230 candles, 200 warm-up → 30 tradeable. This is the #334 case: counting
    // all 230 would pin progress near 0 for a coarse, short-range run.
    expect(tradeableTickCount(series(230), 200)).toBe(30);
  });

  it('floors each symbol at 0 and sums across the portfolio', () => {
    // One symbol shorter than warm-up contributes 0, not a negative.
    expect(tradeableTickCount(series(250, 150), 200)).toBe(50);
  });

  it('returns 0 when every candle is consumed by warm-up (the fail-fast trigger)', () => {
    expect(tradeableTickCount(series(200, 10), 200)).toBe(0);
  });
});
