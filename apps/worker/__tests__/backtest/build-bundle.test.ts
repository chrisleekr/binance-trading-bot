import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Candle } from '@app/strategy-core';
import type { TechnicalsBundleConfig } from '@app/contracts';
import { buildBundle } from '../../src/backtest/backtest-runner.js';
import { LruSignalCache } from '../../src/backtest/signal-cache.js';

const MIN = 60_000;

// Minimal strategy stub exposing only the field buildBundle reads.
const strategy = {
  capabilities: { bundleProviders: ['technicals', 'override'] },
} as unknown as Parameters<typeof buildBundle>[0];

const tvConfig = {
  intervals: [{ interval: '1m', allowBuy: [], forceSell: [] }],
  useOnlyWithinMin: 5,
  ifExpires: 'do-nothing',
} as unknown as TechnicalsBundleConfig;

function candle(closeTimeMs: number, close: string): Candle {
  return {
    openTimeMs: closeTimeMs - MIN + 1,
    closeTimeMs,
    open: close,
    high: close,
    low: close,
    close,
    volume: '1',
    isClosed: true,
  };
}

describe('buildBundle', () => {
  // 30 candles closing at 1m..30m; asOf = 10m → only the first 10 are visible.
  const candles: Candle[] = Array.from({ length: 30 }, (_, i) =>
    candle((i + 1) * MIN, (100 + i).toString()),
  );
  const candlesByKey = new Map<string, Candle[]>([['BTCUSDT|1m', candles]]);

  it('emits the {technicals:{config,signals}, override:null} shape', () => {
    const bundle = buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN);
    expect(bundle).toHaveProperty('technicals');
    expect(bundle).toHaveProperty('override', null);
    const technicals = bundle['technicals'] as { config: unknown; signals: unknown[] };
    expect(technicals.config).toBe(tvConfig);
    expect(Array.isArray(technicals.signals)).toBe(true);
    expect(z.array(z.object({ interval: z.string() })).safeParse(technicals.signals).success).toBe(
      true,
    );
  });

  it('rates over only the most recent RATING_CANDLES (live parity + bounded cost)', () => {
    // The rating depends only on its recent tail, and the live cron rates over
    // KLINE_LIMIT=250 candles. So a 600-candle history and just its last 250
    // must yield the identical signal — proving the bound preserves live parity
    // (and keeps the per-tick cost constant instead of O(growing-history),
    // which made long backtests hang).
    const long: Candle[] = Array.from({ length: 600 }, (_, i) =>
      candle((i + 1) * MIN, (100 + (i % 40)).toString()),
    );
    const asOf = 600 * MIN;
    const signalOf = (cs: Candle[]): unknown => {
      const b = buildBundle(strategy, tvConfig, new Map([['BTCUSDT|1m', cs]]), 'BTCUSDT', asOf);
      return (b['technicals'] as { signals: { signal: unknown }[] }).signals[0]?.signal;
    };
    expect(signalOf(long)).toEqual(signalOf(long.slice(-250)));
  });

  it('memoises the signal by the latest closed candle (cache hit, same result)', () => {
    interface Sig {
      signals: { signal: { recommendation?: string } | null }[];
    }
    const rec = (b: Record<string, unknown>): string | undefined =>
      (b['technicals'] as Sig).signals[0]?.signal?.recommendation;

    const cache = new Map();
    const first = buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN, cache);
    expect(cache.size).toBe(1);
    // A later asOf with no new candle closed (still the 30m candle) is a cache
    // hit — no new entry, and the cached signal is reused (timestamp re-stamped).
    buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN + 30_000, cache);
    expect(cache.size).toBe(1);
    // The cached path yields the same verdict as the uncached path.
    const uncached = buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN);
    expect(rec(first)).toEqual(rec(uncached));
  });

  it('slices the technicals window to closeTimeMs <= asOfMs (no look-ahead)', () => {
    // asOf = 4m: fewer than 5 candles visible → rating window too short → null signal
    const early = buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 4 * MIN);
    const earlySignals = (early['technicals'] as { signals: { signal: unknown }[] }).signals;
    expect(earlySignals[0]?.signal).toBeNull();

    // asOf = 30m: full window → a real signal is produced
    const late = buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN);
    const lateSignals = (late['technicals'] as { signals: { signal: unknown }[] }).signals;
    expect(lateSignals[0]?.signal).not.toBeNull();
  });

  it('a shared LruSignalCache reuses a signal across separate runs over the same candles', () => {
    interface Sig {
      signals: { signal: { recommendation?: string } | null }[];
    }
    const rec = (b: Record<string, unknown>): string | undefined =>
      (b['technicals'] as Sig).signals[0]?.signal?.recommendation;

    // The technicals signal (minus timestamp) is config-independent, so a study's
    // trials share one cache: trial 1 fills it, trial 2 hits it. Modelled here as
    // two buildBundle calls (separate "runs") against the SAME candles and cache.
    const shared = new LruSignalCache(100);
    const run1 = buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN, shared);
    expect(shared.size).toBe(1);
    const run2 = buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN, shared);
    // Second run added no entry (pure hit) and produced the identical verdict.
    expect(shared.size).toBe(1);
    expect(rec(run2)).toEqual(rec(run1));
  });

  it('keys on the window first-close too, so a cold-start window cannot collide with a full one at the same latest close', () => {
    // Two runs end at the same latest close (30m) but see different windows: one
    // has all 30 candles, the other only the last 20 (a shorter cold-start view).
    // Without the first-close in the key both would map to the same slot and the
    // second run would wrongly read the first's signal. Distinct keys ⇒ size 2.
    const short: Candle[] = candles.slice(10); // candles 11m..30m
    const shared = new LruSignalCache(100);
    buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN, shared);
    buildBundle(strategy, tvConfig, new Map([['BTCUSDT|1m', short]]), 'BTCUSDT', 30 * MIN, shared);
    expect(shared.size).toBe(2);
  });

  it('the window cursor yields the same signals as a per-tick rescan across advancing ticks', () => {
    const sigAt = (asOf: number, cursor?: Map<string, number>): unknown => {
      const b = buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', asOf, undefined, cursor);
      return (b['technicals'] as { signals: { signal: unknown }[] }).signals[0]?.signal;
    };
    // One forward-only cursor walked across rising asOf must match a fresh full
    // rescan at each tick (cold start, mid, and full window).
    const cursor = new Map<string, number>();
    for (const min of [4, 5, 10, 20, 30]) {
      expect(sigAt(min * MIN, cursor)).toEqual(sigAt(min * MIN));
    }
  });

  it('re-stamps receivedAtMs on a cache hit so freshness tracks the tick', () => {
    const ts = (b: Record<string, unknown>): number | undefined =>
      (b['technicals'] as { signals: { signal: { receivedAtMs?: number } | null }[] }).signals[0]
        ?.signal?.receivedAtMs;
    const cache = new Map();
    const miss = buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN, cache);
    expect(ts(miss)).toBe(30 * MIN);
    // Same window, later asOf → cache hit, but the timestamp follows the tick.
    const hit = buildBundle(strategy, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN + 30_000, cache);
    expect(ts(hit)).toBe(30 * MIN + 30_000);
  });

  it('omits technicals when the strategy does not declare the provider', () => {
    const noTech = {
      capabilities: { bundleProviders: ['override'] },
    } as unknown as Parameters<typeof buildBundle>[0];
    const bundle = buildBundle(noTech, tvConfig, candlesByKey, 'BTCUSDT', 30 * MIN);
    expect(bundle).not.toHaveProperty('technicals');
    expect(bundle).toHaveProperty('override', null);
  });

  it('arms the entry-hint seam only in discovery mode, and never without the provider', () => {
    const withHint = {
      capabilities: { bundleProviders: ['technicals', 'override', 'entry-hint'] },
    } as unknown as Parameters<typeof buildBundle>[0];
    // discoveryMode is the 8th positional arg (after signalCache, windowCursor).
    const armed = buildBundle(
      withHint,
      tvConfig,
      candlesByKey,
      'BTCUSDT',
      30 * MIN,
      undefined,
      undefined,
      true,
    );
    expect(armed).toHaveProperty('entryHint', { enterOnAdd: true });
    const off = buildBundle(
      withHint,
      tvConfig,
      candlesByKey,
      'BTCUSDT',
      30 * MIN,
      undefined,
      undefined,
      false,
    );
    expect(off).not.toHaveProperty('entryHint');
    // Both conditions of the guard: a strategy lacking 'entry-hint' must not get
    // the key even with discoveryMode on (it cannot read it).
    const armedNoProvider = buildBundle(
      strategy,
      tvConfig,
      candlesByKey,
      'BTCUSDT',
      30 * MIN,
      undefined,
      undefined,
      true,
    );
    expect(armedNoProvider).not.toHaveProperty('entryHint');
  });
});
