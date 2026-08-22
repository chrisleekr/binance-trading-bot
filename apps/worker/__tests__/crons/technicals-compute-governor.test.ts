// Verifies the WeightGovernor wiring on the technicals-compute kline
// fetcher. The fetcher must call `governor.reserve(2)` before each
// underlying REST attempt — including a retried attempt, since each
// retry is an independent budget hit.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Redis } from 'ioredis';
import { createWeightGovernor } from '@app/binance';

import { createFetchAndCache } from '../../src/crons/technicals-compute.js';

const silentLogger = pino({ level: 'silent' });

const stubRedis = (): Redis => {
  const pipe = {
    set: vi.fn(() => pipe),
    exec: vi.fn(async () => []),
  };
  return {
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
    pipeline: () => pipe,
  } as unknown as Redis;
};

const klineRow = (openTimeMs: number, closeTimeMs: number): unknown[] => [
  openTimeMs,
  '100',
  '101',
  '99',
  '100.5',
  '1',
  closeTimeMs,
  '0',
  0,
  '0',
  '0',
  '0',
];

const stubFetch = (status = 200, requests: string[] = []): typeof globalThis.fetch =>
  (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return new Response(
      JSON.stringify(
        Array.from({ length: 251 }, (_, i) =>
          klineRow(1_000 + i * 60_000, 1_000 + (i + 1) * 60_000 - 1),
        ),
      ),
      { status, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;

describe('technicals-compute kline fetcher × WeightGovernor', () => {
  it('reserves weight before each kline REST attempt', async () => {
    const governor = createWeightGovernor({ budget: 1200, targetUtilisation: 1 });
    const reserveSpy = vi.spyOn(governor, 'reserve');
    const requests: string[] = [];
    const fetchAndCache = createFetchAndCache({
      redis: stubRedis(),
      signalTtlSeconds: 60,
      logger: silentLogger,
      fetch: stubFetch(200, requests),
      weightGovernor: governor,
    });
    await fetchAndCache('1h', ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
    expect(reserveSpy).toHaveBeenCalledTimes(3);
    for (const call of reserveSpy.mock.calls) {
      expect(call[0]).toBe(2);
    }
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(new URL(request).searchParams.get('limit')).toBe('1000');
    }
  });

  it('omitting the governor still works (backwards-compatible)', async () => {
    const fetchAndCache = createFetchAndCache({
      redis: stubRedis(),
      signalTtlSeconds: 60,
      logger: silentLogger,
      fetch: stubFetch(),
    });
    await expect(fetchAndCache('1h', ['BTCUSDT'])).resolves.toBeUndefined();
  });

  it('reservation back-pressures: a second batch waits for the first to age out when budget is tight', async () => {
    // Budget=4, ceiling=4. KLINE_WEIGHT=2. Two symbols saturate; a third
    // would need to wait for the first record to expire. Inject a sleep
    // that advances a fake clock so the test runs in real time.
    let now = 1_000_000;
    const clock = { nowMs: () => now };
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
      now += ms;
    };
    const governor = createWeightGovernor({
      budget: 5,
      targetUtilisation: 0.8,
      clock,
      sleep,
    });
    const fetchAndCache = createFetchAndCache({
      redis: stubRedis(),
      signalTtlSeconds: 60,
      logger: silentLogger,
      fetch: stubFetch(),
      weightGovernor: governor,
    });
    await fetchAndCache('1h', ['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
    // ceiling = floor(5 * 0.8) = 4; KLINE_WEIGHT=2. The third reserve
    // pushed total to 6 — over ceiling 4. Should have slept at least once.
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
  });
});
