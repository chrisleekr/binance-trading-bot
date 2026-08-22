// The admission map is the only place the cached symbol-info entry is turned
// into a tradability fact. A cache entry written before permission capture, or
// one carrying a malformed value, must land as "no constraint published" rather
// than as an empty constraint, which would read as forbidden.

import { describe, expect, it, vi } from 'vitest';
import { pino } from 'pino';
import type { Redis } from 'ioredis';

import {
  ADMISSION_SNAPSHOT_MAX_AGE_MS,
  EMPTY_MEMO_MS,
  createSymbolAdmissionResolver,
  fetchSymbolAdmission,
} from '../../../src/crons/discovery/symbol-admission.js';

const silent = pino({ level: 'silent' });

// The two mode keyspaces, spelled out rather than built, because the whole
// mode-isolation guarantee rests on these two globs being unable to match each
// other's keys. A helper call would re-derive the same bug it is meant to catch.
const LIVE_PATTERN = 'binance:symbol-info:*';
const TEST_PATTERN = 'binance:symbol-info-test:*';

type FakeScanRedis = Pick<Redis, 'scan' | 'mget'> & {
  /** MATCH pattern of every SCAN, in call order. Its length is the sweep count, which is the whole cost being measured here. */
  readonly sweeps: string[];
  /** Key batch of every MGET, in call order. */
  readonly fetches: string[][];
};

/**
 * Fake the two Redis commands the admission read uses, counting both.
 *
 * `entries` late-binds so one fake can answer differently per MATCH pattern (the two modes hold different symbols) and can change between sweeps (an unprimed keyspace that fills in later). MGET is served from the union of everything scanned so far, since this fake is only ever asked for keys its own SCAN handed out.
 *
 * @param entries - The keyspace contents, either fixed or resolved per MATCH pattern at sweep time.
 * @param gate - Optional latch a test resolves to release SCAN, so two concurrent resolves are guaranteed to overlap rather than racing to serialise.
 * @returns The fake, with the sweep and fetch logs attached.
 */
const scanRedis = (
  entries: Record<string, string> | ((pattern: string) => Record<string, string>),
  gate?: Promise<void>,
): FakeScanRedis => {
  const at = typeof entries === 'function' ? entries : () => entries;
  const sweeps: string[] = [];
  const fetches: string[][] = [];
  let served: Record<string, string> = {};
  return {
    sweeps,
    fetches,
    // Recorded before the gate, so a sweep that started but has not answered still counts.
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      sweeps.push(pattern);
      if (gate !== undefined) await gate;
      const page = at(pattern);
      served = { ...served, ...page };
      return ['0', Object.keys(page)] as [string, string[]];
    }),
    mget: vi.fn(async (...keys: string[]) => {
      fetches.push(keys);
      return keys.map((k) => served[k] ?? null);
    }),
  } as unknown as FakeScanRedis;
};

/** Injected clock, so a TTL is proven by moving time rather than by waiting for it. */
const fakeClock = (
  startMs = 1_760_000_000_000,
): { clock: { nowMs: () => number }; advance: (ms: number) => void } => {
  let nowMs = startMs;
  return {
    clock: { nowMs: () => nowMs },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
};

const admissionEntry = (symbol: string, baseAsset: string): string =>
  JSON.stringify({ symbol, status: 'TRADING', baseAsset, quoteAsset: 'USDT' });

describe('fetchSymbolAdmission', () => {
  it('carries both the status and a well-formed permission-set list', async () => {
    const redis = scanRedis({
      'symbol-info:live:BTCUSDT': JSON.stringify({
        symbol: 'BTCUSDT',
        status: 'TRADING',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        permissionSets: [['SPOT', 'TRD_GRP_025']],
      }),
    });
    const out = await fetchSymbolAdmission(redis, silent, 'live', 'cron discovery');
    expect(out.get('BTCUSDT')).toEqual({
      status: 'TRADING',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      permissionSets: [['SPOT', 'TRD_GRP_025']],
    });
  });

  it('omits permissionSets entirely for a stale or malformed entry', async () => {
    // Cache entries survive a deploy; one written by the previous build has no
    // permissionSets at all. Omitting the key keeps absent and unreadable
    // identical, and both fail open.
    const redis = scanRedis({
      'symbol-info:live:OLDUSDT': JSON.stringify({
        symbol: 'OLDUSDT',
        status: 'TRADING',
        baseAsset: 'OLD',
        quoteAsset: 'USDT',
      }),
      'symbol-info:live:BADUSDT': JSON.stringify({
        symbol: 'BADUSDT',
        status: 'TRADING',
        baseAsset: 'BAD',
        quoteAsset: 'USDT',
        permissionSets: 'SPOT',
      }),
    });
    const out = await fetchSymbolAdmission(redis, silent, 'live', 'cron discovery');
    expect(out.get('OLDUSDT')).toEqual({
      status: 'TRADING',
      baseAsset: 'OLD',
      quoteAsset: 'USDT',
    });
    expect(out.get('BADUSDT')).toEqual({
      status: 'TRADING',
      baseAsset: 'BAD',
      quoteAsset: 'USDT',
    });
  });

  it('skips one unparseable value without blinding the whole read', async () => {
    const redis = scanRedis({
      'symbol-info:live:BTCUSDT': '{not json',
      'symbol-info:live:ETHUSDT': JSON.stringify({
        symbol: 'ETHUSDT',
        status: 'TRADING',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
      }),
    });
    const out = await fetchSymbolAdmission(redis, silent, 'live', 'cron discovery');
    expect([...out.keys()]).toEqual(['ETHUSDT']);
  });

  it('skips an entry with no base/quote split rather than inventing one', async () => {
    // Every refresh since the keyspace existed writes both, so this is a corrupt
    // value. Guessing a split would mis-classify the asset it names, and the
    // shrunken map then fails the caller's completeness check instead.
    const redis = scanRedis({
      'symbol-info:live:CUTUSDT': JSON.stringify({ symbol: 'CUTUSDT', status: 'TRADING' }),
      'symbol-info:live:ETHUSDT': JSON.stringify({
        symbol: 'ETHUSDT',
        status: 'TRADING',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
      }),
    });
    const out = await fetchSymbolAdmission(redis, silent, 'live', 'cron discovery');
    expect([...out.keys()]).toEqual(['ETHUSDT']);
  });

  it('returns an empty map on a Redis fault rather than throwing', async () => {
    const redis = {
      scan: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      mget: vi.fn(),
    } as unknown as Pick<Redis, 'scan' | 'mget'>;
    expect((await fetchSymbolAdmission(redis, silent, 'live', 'cron discovery')).size).toBe(0);
  });

  it('the raw fetcher re-scans on every call, the cost the resolver removes', async () => {
    // The measured baseline, and a permanent pin: the fetcher stays uncached, so
    // the sharing has to live in the resolver above it where a test can see it.
    // Hide a cache in here instead and this number silently drops, taking with it
    // the only place the read's real cost is still visible.
    const redis = scanRedis({
      'binance:symbol-info:BTCUSDT': admissionEntry('BTCUSDT', 'BTC'),
    });

    await fetchSymbolAdmission(redis, silent, 'live', 'cron discovery');
    await fetchSymbolAdmission(redis, silent, 'live', 'diagnosis funnel');

    expect(redis.sweeps.length).toBe(2);
    expect(redis.fetches.length).toBe(2);
  });
});

// One process holds both readers: the discovery cron builds the admission map on
// its wake, and the diagnosis probe re-derives the same funnel moments later to
// explain why a symbol was cut. Each was sweeping the whole ~1.4k-key symbol-info
// keyspace for itself. The resolver makes that one sweep, without letting either
// reader see a map the other primed under a different mode or a map that is
// really the "unreadable" sentinel.
describe('createSymbolAdmissionResolver', () => {
  it('shares one Redis sweep between the cron build and the diagnosis probe', async () => {
    const redis = scanRedis({
      'binance:symbol-info:BTCUSDT': admissionEntry('BTCUSDT', 'BTC'),
      'binance:symbol-info:ETHUSDT': admissionEntry('ETHUSDT', 'ETH'),
    });
    const { clock, advance } = fakeClock();
    const resolve = createSymbolAdmissionResolver({ redis, logger: silent, clock });

    const build = await resolve('live');
    advance(3_000);
    const probe = await resolve('live');

    expect(redis.sweeps.length).toBe(1);
    // The MGET is the larger half of the cost the sweep carries, so it has to collapse with it.
    expect(redis.fetches.length).toBe(1);
    expect([...probe.entries()]).toEqual([...build.entries()]);
  });

  it('keeps the two modes on their own keyspaces', async () => {
    // A live map served to a test-mode caller binds symbols testnet does not
    // list, and every tick for them DLQs. Sharing must never cross that line.
    const redis = scanRedis((pattern) =>
      pattern === TEST_PATTERN
        ? { 'binance:symbol-info-test:TESTUSDT': admissionEntry('TESTUSDT', 'TEST') }
        : { 'binance:symbol-info:BTCUSDT': admissionEntry('BTCUSDT', 'BTC') },
    );
    const { clock } = fakeClock();
    const resolve = createSymbolAdmissionResolver({ redis, logger: silent, clock });

    const live = await resolve('live');
    const test = await resolve('test');

    expect(redis.sweeps).toEqual([LIVE_PATTERN, TEST_PATTERN]);
    expect([...live.keys()]).toEqual(['BTCUSDT']);
    expect([...test.keys()]).toEqual(['TESTUSDT']);
  });

  it('collapses two concurrent reads onto one in-flight sweep', async () => {
    // The cron loop and the diagnosis queue worker run concurrently in the same
    // process, so the second reader routinely arrives while the first sweep is
    // still out. Without the in-flight memo the sharing buys nothing there.
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const redis = scanRedis(
      { 'binance:symbol-info:BTCUSDT': admissionEntry('BTCUSDT', 'BTC') },
      gate,
    );
    const { clock } = fakeClock();
    const resolve = createSymbolAdmissionResolver({ redis, logger: silent, clock });

    const both = Promise.all([resolve('live'), resolve('live')]);
    release();
    const [first, second] = await both;

    expect(redis.sweeps.length).toBe(1);
    expect(second).toBe(first);
  });

  it('keeps two concurrent reads for different modes on their own sweeps', async () => {
    // `memos` is not the only place the mode key has to be honoured: `inFlight` is
    // a second one, and it is the one a sequential test can never reach. Collapse
    // it to a single promise and a test-mode caller arriving while a live sweep is
    // out is handed the live universe, with every test above still green.
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const redis = scanRedis(
      (pattern) =>
        pattern === TEST_PATTERN
          ? { 'binance:symbol-info-test:TESTUSDT': admissionEntry('TESTUSDT', 'TEST') }
          : { 'binance:symbol-info:BTCUSDT': admissionEntry('BTCUSDT', 'BTC') },
      gate,
    );
    const { clock } = fakeClock();
    const resolve = createSymbolAdmissionResolver({ redis, logger: silent, clock });

    const both = Promise.all([resolve('live'), resolve('test')]);
    release();
    const [live, test] = await both;

    expect(redis.sweeps).toEqual([LIVE_PATTERN, TEST_PATTERN]);
    expect([...live.keys()]).toEqual(['BTCUSDT']);
    expect([...test.keys()]).toEqual(['TESTUSDT']);
  });

  it('never retains an empty map as a fresh snapshot', async () => {
    // An empty map is the shipped sentinel for "unreadable OR unprimed", not an
    // answer. Held for the full snapshot age it would abort discovery for two
    // minutes after a blip that healed in one second, so it gets the short memo
    // that only stops a stampede.
    let primed = false;
    const redis = scanRedis(() =>
      primed ? { 'binance:symbol-info:BTCUSDT': admissionEntry('BTCUSDT', 'BTC') } : {},
    );
    const { clock, advance } = fakeClock();
    const resolve = createSymbolAdmissionResolver({ redis, logger: silent, clock });

    const first = await resolve('live');
    advance(1_000);
    const second = await resolve('live');

    expect(redis.sweeps.length).toBe(1);
    expect(first.size).toBe(0);
    expect(second.size).toBe(0);

    primed = true;
    // Literal ms rather than the constant, for the reason the snapshot-age test uses them: advancing by EMPTY_MEMO_MS itself would pass whatever value it holds. 28_999 lands 29_999 ms after the empty sweep resolved, still inside the window.
    advance(28_999);
    const insideMemo = await resolve('live');

    // Redis has recovered by now and the sentinel is STILL served: that is the price of the window, and it has to be visible here rather than inferred.
    expect(redis.sweeps.length).toBe(1);
    expect(insideMemo.size).toBe(0);

    advance(2);
    const afterMemo = await resolve('live');

    expect(redis.sweeps.length).toBe(2);
    expect([...afterMemo.keys()]).toEqual(['BTCUSDT']);

    // The success replaces the memo outright: no third sweep, and no empty map resurfacing behind the map that is now real.
    const next = await resolve('live');

    expect(redis.sweeps.length).toBe(2);
    expect(next).toBe(afterMemo);
  });

  it('re-sweeps once the snapshot ages out', async () => {
    // Literal ms rather than the constant, so widening the constant fails here
    // instead of quietly moving the boundary this test claims to pin.
    const redis = scanRedis({ 'binance:symbol-info:BTCUSDT': admissionEntry('BTCUSDT', 'BTC') });
    const { clock, advance } = fakeClock();
    const resolve = createSymbolAdmissionResolver({ redis, logger: silent, clock });

    await resolve('live');
    advance(119_999);
    await resolve('live');

    expect(redis.sweeps.length).toBe(1);

    advance(2);
    await resolve('live');

    expect(redis.sweeps.length).toBe(2);
  });

  it('holds the snapshot longer than the discovery wake and shorter than the writer cadence', () => {
    // Below the 60s wake and every wake pays for its own sweep, which is the cost
    // being removed. At or above the 5-min exchange-info-refresh cadence a whole
    // write of the keyspace can land unseen. The TTL must equal neither bound.
    expect(ADMISSION_SNAPSHOT_MAX_AGE_MS).toBeGreaterThan(60_000);
    expect(ADMISSION_SNAPSHOT_MAX_AGE_MS).toBeLessThan(5 * 60_000);
    expect(EMPTY_MEMO_MS).toBeLessThan(ADMISSION_SNAPSHOT_MAX_AGE_MS);
    // The sentinel window is the one bound no other test constrains. Under the nominal 60s wake, so a sentinel stamped by one wake is normally gone by the next; the cron self-reschedules at max(0, period - runtime), so an overrunning wake can still reuse it, and the bound is the duration rather than the boundary.
    expect(EMPTY_MEMO_MS).toBeLessThan(60_000);
  });
});
