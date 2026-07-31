// Candle-close gate for the technicals-compute cron. A Technical Rating can
// only change when a candle closes, so the cron skips the Binance fetch while
// the current closed-candle boundary matches what it last computed — refreshing
// the cached signals' TTL and the receipt without spending weight. A new
// candle, a missing cached signal (new symbol), or a missing receipt (self-heal)
// forces a real fetch.

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

// Non-retriable 4xx: fetchClosedKlines throws without a backoff sleep, so a
// candle-closed pass reaches written===0 fast.
const errored = (status: number): Response => new Response('bad', { status });

const HOUR_MS = 3_600_000;
const NOW = 1_700_001_800_000;
const BOUNDARY = Math.floor(NOW / HOUR_MS) * HOUR_MS;

// A cached signal JSON with a stale `receivedAtMs` (the ~32.5-min-old value the
// live pod inherited across a 1h boundary). Only `receivedAtMs` matters to the
// skip-branch re-stamp; the other fields ride along unchanged.
const STALE_RECEIVED_AT_MS = NOW - 1_950_000;
const cachedSignal = (receivedAtMs: number): string =>
  JSON.stringify({ symbol: 'BINANCE:BTCUSDT', recommendation: 'BUY', receivedAtMs });

const receipt = (lastComputedCloseMs: number | null): string =>
  JSON.stringify({
    interval: '1h',
    fetchedAtMs: NOW - 30_000,
    requested: 1,
    written: 1,
    skippedErrored: 0,
    skippedInvalid: 0,
    latencyMs: 5,
    lastFreshAtMs: NOW - 30_000,
    lastComputedCloseMs,
    error: null,
  });

const stubPipeline = ({ failCommit = false, commandError = false } = {}) => {
  const ops: { key: string; value: string }[] = [];
  const fakePipe = {
    set: vi.fn((key: string, value: string) => {
      ops.push({ key, value });
      return fakePipe;
    }),
    exec: vi.fn(async () => {
      if (failCommit) throw new Error('EXEC boom'); // whole commit rejects
      // Per-command failure: `.exec()` resolves, the error rides in the tuple.
      if (commandError)
        return ops.map((_, i) => (i === 0 ? [new Error('OOM'), null] : [null, 'OK']));
      return ops.map(() => [null, 'OK']);
    }),
    _ops: ops,
  };
  return fakePipe;
};

interface RedisStubOpts {
  readonly priorReceipt: string | null;
  readonly cached: (string | null)[];
}

const stubRedis = (pipe: ReturnType<typeof stubPipeline>, opts: RedisStubOpts) => {
  const setCalls: { key: string; value: string }[] = [];
  const redis = {
    pipeline: vi.fn(() => pipe),
    get: vi.fn(async () => opts.priorReceipt),
    mget: vi.fn(async () => opts.cached),
    set: vi.fn(async (key: string, value: string) => {
      setCalls.push({ key, value });
      return 'OK';
    }),
  } as unknown as Redis & { _setCalls: typeof setCalls };
  (redis as unknown as { _setCalls: typeof setCalls })._setCalls = setCalls;
  return redis as unknown as Redis & { _setCalls: typeof setCalls };
};

const make = (redis: Redis, fetch: ReturnType<typeof vi.fn>) =>
  createFetchAndCache({
    redis,
    signalTtlSeconds: 600,
    clock: { nowMs: () => NOW },
    logger: stubLogger,
    fetch: fetch as unknown as typeof globalThis.fetch,
  });

describe('createFetchAndCache — candle-close gate', () => {
  it('skips the fetch when no candle has closed and every signal is cached', async () => {
    const fetch = vi.fn();
    const pipe = stubPipeline();
    const redis = stubRedis(pipe, {
      priorReceipt: receipt(BOUNDARY), // already computed this boundary
      cached: [cachedSignal(STALE_RECEIVED_AT_MS)],
    });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    expect(fetch).not.toHaveBeenCalled();
    // The cached signal is re-SET to refresh its 600s TTL, with receivedAtMs
    // re-stamped to now (the rating is confirmed still current).
    expect(pipe._ops).toHaveLength(1);
    expect(pipe._ops[0]?.key).toEqual(expect.stringContaining('BTCUSDT'));
    const reSet = JSON.parse(pipe._ops[0]?.value ?? '{}') as Record<string, unknown>;
    expect(reSet['receivedAtMs']).toBe(NOW);
    expect(reSet['recommendation']).toBe('BUY'); // other fields preserved
    // The receipt is rewritten with written:0 and the boundary preserved.
    const receiptWrite = redis._setCalls.find((c) => c.key.includes('fetch-status'));
    expect(receiptWrite).toBeDefined();
    const parsed = JSON.parse(receiptWrite?.value ?? '{}') as Record<string, unknown>;
    expect(parsed['written']).toBe(0);
    expect(parsed['lastComputedCloseMs']).toBe(BOUNDARY);
  });

  it('re-stamps the signal receivedAtMs and the receipt lastFreshAtMs to the same skip time', async () => {
    const fetch = vi.fn();
    const pipe = stubPipeline();
    const redis = stubRedis(pipe, {
      priorReceipt: receipt(BOUNDARY),
      cached: [cachedSignal(STALE_RECEIVED_AT_MS)],
    });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    // The gate reads signal.receivedAtMs; the dashboard reads receipt.lastFreshAtMs.
    // A healthy skip must advance BOTH to the same time so the two freshness
    // notions cannot diverge (fresh on UI, stale at gate).
    const signalReceivedAtMs = (JSON.parse(pipe._ops[0]?.value ?? '{}') as Record<string, unknown>)[
      'receivedAtMs'
    ];
    const receiptWrite = redis._setCalls.find((c) => c.key.includes('fetch-status'));
    const receiptLastFreshAtMs = (
      JSON.parse(receiptWrite?.value ?? '{}') as Record<string, unknown>
    )['lastFreshAtMs'];
    expect(signalReceivedAtMs).toBe(NOW);
    expect(receiptLastFreshAtMs).toBe(NOW);
    expect(signalReceivedAtMs).toBe(receiptLastFreshAtMs);
  });

  it('does NOT advance receivedAtMs when a due compute fails (candle closed, fetch errors)', async () => {
    const fetch = vi.fn().mockResolvedValue(errored(400)); // non-retriable → written:0, no backoff
    const pipe = stubPipeline();
    const redis = stubRedis(pipe, {
      priorReceipt: receipt(BOUNDARY - HOUR_MS), // candle closed → a real fetch is due
      cached: [cachedSignal(STALE_RECEIVED_AT_MS)],
    });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    expect(fetch).toHaveBeenCalledTimes(1); // candle-closed path taken, not the skip
    // The fetch failed, so the signal key is never re-SET — its stale
    // receivedAtMs survives and a genuine outage still trips technicals-stale.
    expect(pipe._ops).toHaveLength(0);
    const receiptWrite = redis._setCalls.find((c) => c.key.includes('fetch-status'));
    const parsed = JSON.parse(receiptWrite?.value ?? '{}') as Record<string, unknown>;
    expect(parsed['written']).toBe(0);
    expect(parsed['error']).not.toBeNull();
  });

  it('re-stores a malformed cached signal unchanged on skip (TTL refresh still applies)', async () => {
    const fetch = vi.fn();
    const pipe = stubPipeline();
    const redis = stubRedis(pipe, {
      priorReceipt: receipt(BOUNDARY),
      cached: ['not json'], // parse fails inside restampReceivedAt
    });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    expect(fetch).not.toHaveBeenCalled();
    // Fallback: the raw value is re-SET unchanged so the TTL still refreshes.
    expect(pipe._ops).toHaveLength(1);
    expect(pipe._ops[0]?.value).toBe('not json');
  });

  it('records an error and holds lastFreshAtMs when the skip refresh commit fails', async () => {
    const fetch = vi.fn();
    const pipe = stubPipeline({ failCommit: true });
    const redis = stubRedis(pipe, {
      priorReceipt: receipt(BOUNDARY),
      cached: [cachedSignal(STALE_RECEIVED_AT_MS)],
    });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    expect(fetch).not.toHaveBeenCalled();
    const receiptWrite = redis._setCalls.find((c) => c.key.includes('fetch-status'));
    const parsed = JSON.parse(receiptWrite?.value ?? '{}') as Record<string, unknown>;
    // The signals were NOT re-stamped (commit failed), so the receipt must not
    // claim fresh: it records the error and holds lastFreshAtMs at the prior
    // value, so the gate and dashboard cannot diverge (invariant #2).
    expect(parsed['error']).toMatch(/signal-refresh/);
    expect(parsed['lastFreshAtMs']).toBe(NOW - 30_000); // prior receipt value, not NOW
  });

  it('records an error when a skip refresh SET fails without rejecting the commit', async () => {
    const fetch = vi.fn();
    const pipe = stubPipeline({ commandError: true }); // .exec() resolves, tuple carries the error
    const redis = stubRedis(pipe, {
      priorReceipt: receipt(BOUNDARY),
      cached: [cachedSignal(STALE_RECEIVED_AT_MS)],
    });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    const receiptWrite = redis._setCalls.find((c) => c.key.includes('fetch-status'));
    const parsed = JSON.parse(receiptWrite?.value ?? '{}') as Record<string, unknown>;
    // A per-command SET failure must be caught too, else the receipt would
    // falsely claim fresh while the signal was never re-stamped.
    expect(parsed['error']).toMatch(/signal-refresh/);
    expect(parsed['lastFreshAtMs']).toBe(NOW - 30_000);
  });

  it('records an error when a compute-path SET fails without rejecting the commit', async () => {
    const klines = Array.from({ length: 250 }, () => closedKline(NOW - 60_000));
    const fetch = vi.fn().mockResolvedValue(ok(klines));
    const pipe = stubPipeline({ commandError: true }); // .exec() resolves, tuple carries the error
    const redis = stubRedis(pipe, {
      priorReceipt: receipt(BOUNDARY - HOUR_MS), // candle closed → the compute path runs
      cached: ['{"signal":"BUY"}'],
    });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    expect(fetch).toHaveBeenCalledTimes(1); // compute path taken, not the skip
    const receiptWrite = redis._setCalls.find((c) => c.key.includes('fetch-status'));
    const parsed = JSON.parse(receiptWrite?.value ?? '{}') as Record<string, unknown>;
    // A per-command SET failure must be caught too, else the receipt would
    // falsely report the signal fresh (written>0, error null) while the SET
    // never landed.
    expect(parsed['error']).not.toBeNull();
    expect(parsed['written']).toBe(0);
  });

  it('does NOT emit compute-recovered when the skip refresh commit fails', async () => {
    (stubLogger.info as ReturnType<typeof vi.fn>).mockClear();
    const fetch = vi.fn();
    const pipe = stubPipeline({ failCommit: true });
    // Prior batch errored on the same boundary — a healthy skip would recover,
    // but a failed refresh must NOT report recovery (nothing was persisted).
    const erroredReceipt = JSON.stringify({
      interval: '1h',
      fetchedAtMs: NOW - 30_000,
      requested: 1,
      written: 0,
      skippedErrored: 1,
      skippedInvalid: 0,
      latencyMs: 5,
      lastFreshAtMs: NOW - 90_000,
      lastComputedCloseMs: BOUNDARY,
      error: 'pipeline: boom',
    });
    const redis = stubRedis(pipe, {
      priorReceipt: erroredReceipt,
      cached: [cachedSignal(STALE_RECEIVED_AT_MS)],
    });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    const recovered = (stubLogger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === 'technicals compute-recovered',
    );
    expect(recovered).toBeUndefined();
  });

  it('fetches when a new candle has closed since the last compute', async () => {
    const klines = Array.from({ length: 250 }, () => closedKline(NOW - 60_000));
    const fetch = vi.fn().mockResolvedValue(ok(klines));
    const pipe = stubPipeline();
    const redis = stubRedis(pipe, {
      priorReceipt: receipt(BOUNDARY - HOUR_MS), // last computed one candle ago
      cached: ['{"signal":"BUY"}'],
    });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    expect(fetch).toHaveBeenCalledTimes(1);
    const receiptWrite = redis._setCalls.find((c) => c.key.includes('fetch-status'));
    const parsed = JSON.parse(receiptWrite?.value ?? '{}') as Record<string, unknown>;
    // Boundary advances to the just-closed candle.
    expect(parsed['lastComputedCloseMs']).toBe(BOUNDARY);
    expect(parsed['written']).toBe(1);
  });

  it('fetches when a requested symbol has no cached signal, even on the same boundary', async () => {
    const klines = Array.from({ length: 250 }, () => closedKline(NOW - 60_000));
    const fetch = vi.fn().mockResolvedValue(ok(klines));
    const pipe = stubPipeline();
    const redis = stubRedis(pipe, {
      priorReceipt: receipt(BOUNDARY), // same boundary…
      cached: ['{"signal":"BUY"}', null], // …but the second symbol is missing
    });
    await make(redis, fetch)('1h', ['BTCUSDT', 'ETHUSDT']);

    expect(fetch).toHaveBeenCalledTimes(2); // both symbols fetched
  });

  it('fetches when the prior receipt is missing (self-heal after a gap)', async () => {
    const klines = Array.from({ length: 250 }, () => closedKline(NOW - 60_000));
    const fetch = vi.fn().mockResolvedValue(ok(klines));
    const pipe = stubPipeline();
    const redis = stubRedis(pipe, { priorReceipt: null, cached: ['{"signal":"BUY"}'] });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('emits compute-recovered when a recovery lands on a skip iteration', async () => {
    (stubLogger.info as ReturnType<typeof vi.fn>).mockClear();
    const fetch = vi.fn();
    const pipe = stubPipeline();
    // Prior receipt: same boundary already computed, but the last batch errored.
    const erroredReceipt = JSON.stringify({
      interval: '1h',
      fetchedAtMs: NOW - 30_000,
      requested: 1,
      written: 0,
      skippedErrored: 1,
      skippedInvalid: 0,
      latencyMs: 5,
      lastFreshAtMs: NOW - 90_000,
      lastComputedCloseMs: BOUNDARY,
      error: 'pipeline: boom',
    });
    const redis = stubRedis(pipe, { priorReceipt: erroredReceipt, cached: ['{"signal":"BUY"}'] });
    await make(redis, fetch)('1h', ['BTCUSDT']);

    expect(fetch).not.toHaveBeenCalled();
    const recovered = (stubLogger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === 'technicals compute-recovered',
    );
    expect(recovered).toBeDefined();
    expect((recovered?.[0] as { downtimeMs: number }).downtimeMs).toBe(90_000);
  });

  it('does not gate an unknown interval (intervalToMs throws → always fetch)', async () => {
    const klines = Array.from({ length: 250 }, () => closedKline(NOW - 60_000));
    const fetch = vi.fn().mockResolvedValue(ok(klines));
    const pipe = stubPipeline();
    const redis = stubRedis(pipe, {
      priorReceipt: receipt(BOUNDARY),
      cached: ['{"signal":"BUY"}'],
    });
    await make(redis, fetch)('7h', ['BTCUSDT']); // 7h is not a known interval

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
