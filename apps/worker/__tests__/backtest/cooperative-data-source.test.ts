// The replay engine drives a tight `for await` over the data source. A long
// CPU-bound run otherwise pins the event loop for minutes, starving the worker
// heartbeat, progress writes, and BullMQ lock renewal. `cooperativeDataSource`
// cedes the loop every N ticks; these tests pin the pass-through identity (the
// golden replay must not change) and that it actually yields mid-stream.
import { describe, expect, it } from 'vitest';
import type { Candle } from '@app/strategy-core';
import {
  arrayMarketDataSource,
  type MarketDataSource,
  type MarketTick,
  type StreamRequest,
  type SymbolCandles,
} from '@app/strategy-backtest';
import { cooperativeDataSource, throttleSleepMs } from '../../src/backtest/backtest-runner.js';

const HOUR = 3_600_000;

const candle = (openTimeMs: number): Candle => ({
  openTimeMs,
  closeTimeMs: openTimeMs + HOUR - 1,
  open: '1',
  high: '1',
  low: '1',
  close: '1',
  volume: '1',
  isClosed: true,
});

const series = (n: number): SymbolCandles[] => [
  {
    symbol: 'BTCUSDT',
    interval: '1h',
    candles: Array.from({ length: n }, (_, k) => candle(k * HOUR)),
  },
];

const req: StreamRequest = {
  symbols: ['BTCUSDT'],
  intervals: ['1h'],
  fromMs: 0,
  toMs: HOUR * 10_000,
};

const collect = async (src: MarketDataSource): Promise<MarketTick[]> => {
  const out: MarketTick[] = [];
  for await (const tick of src.stream(req)) out.push(tick);
  return out;
};

describe('cooperativeDataSource', () => {
  it('streams the same ticks in the same order as the inner source', async () => {
    const expected = await collect(arrayMarketDataSource(series(10)));
    const wrapped = await collect(
      cooperativeDataSource(arrayMarketDataSource(series(10)), { everyN: 3 }),
    );
    expect(wrapped.map((t) => t.candle.openTimeMs)).toEqual(
      expected.map((t) => t.candle.openTimeMs),
    );
    expect(wrapped).toHaveLength(10);
  });

  it('cedes the event loop before the stream completes', async () => {
    const wrapped = cooperativeDataSource(arrayMarketDataSource(series(6)), { everyN: 2 });
    let consumed = 0;
    let ranAt = -1;
    // A macrotask queued before consumption can only run mid-stream if the
    // replay yields; without a yield it would run only after the stream drains.
    setImmediate(() => {
      ranAt = consumed;
    });
    for await (const tick of wrapped.stream(req)) {
      void tick;
      consumed++;
    }
    expect(consumed).toBe(6);
    expect(ranAt).toBeGreaterThanOrEqual(0);
    expect(ranAt).toBeLessThan(6);
  });

  it('passes every tick through when the yield interval exceeds the stream length', async () => {
    const wrapped = cooperativeDataSource(arrayMarketDataSource(series(4)), { everyN: 1000 });
    expect(await collect(wrapped)).toHaveLength(4);
  });

  it('preserves tick identity under a CPU-share throttle', async () => {
    // The throttle only changes *when* ticks flow, never which or their order —
    // the golden-replay invariant must hold with a fractional share too.
    const expected = await collect(arrayMarketDataSource(series(8)));
    const wrapped = await collect(
      cooperativeDataSource(arrayMarketDataSource(series(8)), { cpuShare: 0.5, everyN: 2 }),
    );
    expect(wrapped.map((t) => t.candle.openTimeMs)).toEqual(
      expected.map((t) => t.candle.openTimeMs),
    );
  });
});

describe('throttleSleepMs', () => {
  it('does not sleep at or above full speed', () => {
    expect(throttleSleepMs(50, 1)).toBe(0);
    expect(throttleSleepMs(50, 2)).toBe(0);
  });

  it('sleeps to hold the target duty cycle', () => {
    // share 0.5 -> equal work and sleep; 0.25 -> sleep 3x the work.
    expect(throttleSleepMs(50, 0.5)).toBe(50);
    expect(throttleSleepMs(30, 0.25)).toBe(90);
  });
});
