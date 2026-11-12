import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';
import { buildTickSeries } from '../../src/backtest/replay.js';

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
  it('streams the detail candles under the detail interval', () => {
    const byKey = new Map<string, Candle[]>([
      ['BTCUSDT|1h', [candle(0, HOUR)]],
      ['BTCUSDT|5m', [candle(0, FIVE_MIN), candle(FIVE_MIN, FIVE_MIN)]],
    ]);
    const out = buildTickSeries(['BTCUSDT'], byKey, '5m');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: 'BTCUSDT', interval: '5m' });
    expect(out[0]?.candles).toHaveLength(2);
    expect(out[0]?.detailCandles).toBeUndefined();
  });

  it('yields an empty series for a symbol with no loaded candles', () => {
    const out = buildTickSeries(['BTCUSDT'], new Map(), '5m');
    expect(out[0]?.candles).toEqual([]);
  });
});
