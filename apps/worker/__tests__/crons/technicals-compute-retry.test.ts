// Retry+backoff contract for the Binance klines fetch inside the
// technicals-compute cron. Locks: one retry on 418/429/5xx (honouring
// Retry-After up to RETRY_MAX_MS=2s in @app/binance public-klines), one retry on transient
// network/timeout/abort, no retry on non-retriable 4xx, and the
// retry budget is exhausted after one attempt.

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import { createFetchAndCache } from '../../src/crons/technicals-compute.js';

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

const closedKline = (closeTimeMs: number): readonly unknown[] => [
  0,
  '100',
  '110',
  '90',
  '105',
  '1',
  closeTimeMs,
  '0',
  0,
  '0',
  '0',
  '0',
];

const ok = (rows: readonly (readonly unknown[])[]): Response =>
  new Response(JSON.stringify(rows), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const errored = (status: number, retryAfter?: string): Response =>
  new Response('', { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });

const stubPipeline = () => {
  const ops: { key: string; value: string }[] = [];
  const fakePipe = {
    set: vi.fn((key: string, value: string) => {
      ops.push({ key, value });
      return fakePipe;
    }),
    // ioredis pipelines complete with .exec() returning [Error|null, reply][]
    exec: vi.fn(async () => ops.map(() => [null, 'OK'])),
    _ops: ops,
  };
  return fakePipe;
};

const stubRedis = (pipe: ReturnType<typeof stubPipeline>): Redis => {
  return {
    pipeline: vi.fn(() => pipe),
    get: vi.fn(async () => null),
    set: vi.fn(async () => 'OK'),
  } as unknown as Redis;
};

describe('createFetchAndCache — Binance klines retry+backoff', () => {
  it('retries once on HTTP 429 then succeeds on second attempt', async () => {
    const nowMs = 1_700_000_000_000;
    const klineRow = closedKline(nowMs - 60_000);
    const klines = Array.from({ length: 250 }, () => klineRow);

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(errored(429, '0'))
      .mockResolvedValueOnce(ok(klines));

    const pipe = stubPipeline();
    const fetchAndCache = createFetchAndCache({
      redis: stubRedis(pipe),
      signalTtlSeconds: 300,
      clock: { nowMs: () => nowMs },
      logger: stubLogger,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await fetchAndCache('1m', ['BTCUSDT']);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(pipe._ops).toHaveLength(1);
    expect(pipe._ops[0]?.key).toMatch(/BTCUSDT/);
  });

  it('retries once on HTTP 503 then surfaces the error after the retry', async () => {
    const nowMs = 1_700_000_000_000;
    const fetch = vi.fn().mockResolvedValue(errored(503));

    const pipe = stubPipeline();
    const fetchAndCache = createFetchAndCache({
      redis: stubRedis(pipe),
      signalTtlSeconds: 300,
      clock: { nowMs: () => nowMs },
      logger: stubLogger,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await fetchAndCache('1m', ['BTCUSDT']);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(pipe._ops).toHaveLength(0);
  });

  it('does NOT retry on HTTP 400 (non-retriable 4xx)', async () => {
    const nowMs = 1_700_000_000_000;
    const fetch = vi.fn().mockResolvedValue(errored(400));

    const pipe = stubPipeline();
    const fetchAndCache = createFetchAndCache({
      redis: stubRedis(pipe),
      signalTtlSeconds: 300,
      clock: { nowMs: () => nowMs },
      logger: stubLogger,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await fetchAndCache('1m', ['BTCUSDT']);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('caps Retry-After at 2000ms even when the upstream asks for longer', async () => {
    const nowMs = 1_700_000_000_000;
    const klineRow = closedKline(nowMs - 60_000);
    const klines = Array.from({ length: 250 }, () => klineRow);

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(errored(429, '120'))
      .mockResolvedValueOnce(ok(klines));

    const pipe = stubPipeline();
    const fetchAndCache = createFetchAndCache({
      redis: stubRedis(pipe),
      signalTtlSeconds: 300,
      clock: { nowMs: () => nowMs },
      logger: stubLogger,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const startWall = Date.now();
    await fetchAndCache('1m', ['BTCUSDT']);
    const elapsedMs = Date.now() - startWall;

    expect(fetch).toHaveBeenCalledTimes(2);
    // RETRY_MAX_MS (in @app/binance public-klines) is 2000ms; this bound only needs to be tight enough
    // to catch a regression that drops the cap (which would push the sleep to
    // the upstream-requested 120000ms). Loosened from 3000 → 4500 because
    // slower CI runners hit 3016ms of overhead on top of the 2000ms cap and
    // the resulting flake masked a real failure on iter8's pipeline.
    expect(elapsedMs).toBeLessThan(4_500);
  });

  it('retries once on a transient network error then surfaces when it persists', async () => {
    const nowMs = 1_700_000_000_000;
    const fetch = vi.fn().mockRejectedValue(new Error('fetch failed: ECONNRESET'));

    const pipe = stubPipeline();
    const fetchAndCache = createFetchAndCache({
      redis: stubRedis(pipe),
      signalTtlSeconds: 300,
      clock: { nowMs: () => nowMs },
      logger: stubLogger,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await fetchAndCache('1m', ['BTCUSDT']);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(pipe._ops).toHaveLength(0);
  });

  it('does NOT retry on a parser-shape error (non-transient)', async () => {
    const nowMs = 1_700_000_000_000;
    const fetch = vi.fn().mockResolvedValue(
      new Response('{"not":"an array"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const pipe = stubPipeline();
    const fetchAndCache = createFetchAndCache({
      redis: stubRedis(pipe),
      signalTtlSeconds: 300,
      clock: { nowMs: () => nowMs },
      logger: stubLogger,
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await fetchAndCache('1m', ['BTCUSDT']);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
