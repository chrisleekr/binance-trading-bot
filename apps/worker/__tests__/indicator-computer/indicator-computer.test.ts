// Behaviour tests for the IndicatorComputer rewire.
//
// Three semantic differences between the old (full-window) and new
// (incremental) forms:
//
//   - SMA is window-local: identical between the two forms.
//   - EMA/RSI are recursive: the old form re-seeded on every tick from
//     a sliding 20-candle base, so the seed drifted forward by 1 candle
//     each tick. The new form seeds once (at the first tick where the
//     window is long enough) and folds every subsequent candle in — never
//     re-seeding. Mathematically the incremental form is the correct EMA
//     / Wilder RSI; the windowed form was an implementation artifact.
//
// These tests verify: SMA matches the full-window form; EMA / RSI match
// the incremental indicator package's own full-history form; rebuild
// resets state; per-symbol state stays isolated.

import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type { Redis } from 'ioredis';
import type { Candle } from '@app/strategy-core';
import { ath, sma as fullSma } from '@app/indicators';
import {
  incrementalEMA,
  incrementalRSI,
  incrementalSMA,
  type IncrementalIndicator,
} from '@app/indicators/incremental';

// Tests don't import decimal.js directly (banned outside money-math packages).
// The indicator value's only test-side use is `.toFixed()`; the generic
// constraint covers Decimal without naming it.
interface ToFixed {
  toFixed(): string;
}

import {
  athKey,
  createIndicatorComputer,
  type IndicatorComputer,
  type IndicatorComputerOptions,
} from '../../src/indicator-computer/indicator-computer.js';

const silentLogger = pino({ level: 'silent' });

// Minimal in-memory Redis stub: SET / GET / DEL. The computer no longer
// reads or writes candle ZSETs (the port's ring is the candle store), so
// the stub only needs the indicator-state / indicator-bundle / ath SET
// surface.
const stubRedis = (): Redis & {
  kvs: Map<string, string>;
} => {
  const kvs = new Map<string, string>();
  return {
    kvs,
    set: vi.fn(async (key: string, value: string) => {
      kvs.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => kvs.get(key) ?? null),
    del: vi.fn(async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) {
        if (kvs.delete(k)) n++;
      }
      return n;
    }),
  } as unknown as Redis & { kvs: Map<string, string> };
};

// Test harness: wraps `createIndicatorComputer` with a per-(symbol, interval)
// candle ring so the `loadWindow` callback can answer with the same window
// the production KlineFetcher ring would carry. `recompute(symbol, interval,
// candle)` pushes to the ring before delegating (mirroring the production
// order: KlineFetcher fans into the ring, then to subscribers); `rebuild`
// seeds the ring; `clear` empties it. Tests interact with the wrapped
// computer exactly the way they did against the ZSET-backed version, so
// no per-call call-site changes are needed.
const createTestComputer = (
  redis: Redis,
  options: Omit<IndicatorComputerOptions, 'redis' | 'loadWindow'>,
): IndicatorComputer => {
  const ring = new Map<string, Candle[]>();
  const ringKey = (symbol: string, interval: string): string => `${symbol}:${interval}`;
  const inner = createIndicatorComputer({
    ...options,
    redis,
    loadWindow: async (symbol, interval, size) => {
      const buf = ring.get(ringKey(symbol, interval)) ?? [];
      return buf.slice(Math.max(0, buf.length - size));
    },
  });
  const windowSize =
    options.windowSize ??
    // matches DEFAULT_WINDOW in indicator-computer
    200;
  return {
    async recompute(symbol, interval, candle) {
      const k = ringKey(symbol, interval);
      const buf = ring.get(k) ?? [];
      buf.push({ ...candle, isClosed: true });
      // cap to windowSize+1 so the ring matches the production buffer cap
      while (buf.length > windowSize + 1) buf.shift();
      ring.set(k, buf);
      return inner.recompute(symbol, interval, candle);
    },
    async rebuild(symbol, interval, candles) {
      ring.set(ringKey(symbol, interval), [...candles]);
      return inner.rebuild(symbol, interval, candles);
    },
    async clear(symbol, interval) {
      // `clear` drops indicator state only — the candle ring lives on
      // the port (KlineFetcher) and is not owned by the computer.
      // Leaving the ring intact lets the next recompute re-seed indicator
      // state from the live window without a REST round-trip, matching
      // production behaviour.
      return inner.clear(symbol, interval);
    },
  };
};

// Deterministic LCG candle fixture — matches the shape used by the
// incremental-indicator equivalence tests.
const buildFixture = (length: number): Candle[] => {
  const candles: Candle[] = [];
  let close = 100;
  for (let i = 0; i < length; i++) {
    const seed = ((i * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    close += (seed - 0.5) * 3;
    const high = close + 0.4 + seed * 0.6;
    const low = close - 0.4 - (1 - seed) * 0.6;
    candles.push({
      openTimeMs: i * 60_000,
      closeTimeMs: (i + 1) * 60_000 - 1,
      open: close.toString(),
      high: high.toString(),
      low: low.toString(),
      close: close.toString(),
      volume: '1',
      isClosed: true,
    });
  }
  return candles;
};

const INDICATOR_KEY = 'indicators:BTCUSDT:1h';

const readBundle = (redis: {
  kvs: Map<string, string>;
}): { sma20: string | null; ema20: string | null; rsi14: string | null; windowSize: number } => {
  const raw = redis.kvs.get(INDICATOR_KEY);
  if (!raw) throw new Error('bundle not written');
  return JSON.parse(raw) as never;
};

describe('IndicatorComputer (incremental rewire)', () => {
  it('SMA is window-local and matches the full-window reference (Decimal-equal)', async () => {
    const redis = stubRedis();
    const windowSize = 50;
    const computer = createTestComputer(redis, { logger: silentLogger, windowSize });
    const fixture = buildFixture(60);

    for (let i = 0; i < fixture.length; i++) {
      const c = fixture[i] as Candle;
      await computer.recompute('BTCUSDT', '1h', { ...c });
      const bundle = readBundle(redis);
      const lo = Math.max(0, i - windowSize + 1);
      const window = fixture.slice(lo, i + 1);
      const expectedSma = window.length >= 20 ? fullSma(window, 20).toFixed() : null;
      expect(bundle.sma20).toBe(expectedSma);
      expect(bundle.windowSize).toBe(window.length);
    }
  });

  it('EMA and RSI match the incremental indicator package output exactly', async () => {
    const redis = stubRedis();
    const windowSize = 50;
    const computer = createTestComputer(redis, { logger: silentLogger, windowSize });
    const fixture = buildFixture(60);

    const runShadow = <S, V extends ToFixed>(
      ind: IncrementalIndicator<S, V>,
      minWindow: number,
    ): (string | null)[] => {
      const out: (string | null)[] = [];
      let state: S | null = null;
      for (let i = 0; i < fixture.length; i++) {
        const lo = Math.max(0, i - windowSize + 1);
        const window = fixture.slice(lo, i + 1);
        const closed = fixture[i] as Candle;
        if (state === null) {
          if (window.length < minWindow) {
            out.push(null);
            continue;
          }
          state = ind.initFromWindow(window);
          out.push(ind.currentValue(state).toFixed());
        } else {
          const [next, value] = ind.update(state, closed);
          state = next;
          out.push(value.toFixed());
        }
      }
      return out;
    };

    const expectedEma = runShadow(incrementalEMA(20), 20);
    const expectedRsi = runShadow(incrementalRSI(14), 15);
    // Sanity-check the shadow's SMA matches the full-window form so the
    // shadow harness itself is trustworthy.
    const expectedSma = runShadow(incrementalSMA(20), 20);

    for (let i = 0; i < fixture.length; i++) {
      const c = fixture[i] as Candle;
      await computer.recompute('BTCUSDT', '1h', { ...c });
      const bundle = readBundle(redis);
      expect(bundle.sma20).toBe(expectedSma[i] ?? null);
      expect(bundle.ema20).toBe(expectedEma[i] ?? null);
      expect(bundle.rsi14).toBe(expectedRsi[i] ?? null);
    }
  });

  it('rebuild resets state and re-seeds from supplied candles', async () => {
    const redis = stubRedis();
    const computer = createTestComputer(redis, { logger: silentLogger, windowSize: 50 });
    const fixture = buildFixture(40);

    // Warm the computer with the first 30 candles.
    for (const c of fixture.slice(0, 30)) {
      await computer.recompute('BTCUSDT', '1h', { ...c });
    }

    // Rebuild with a fresh slice — bundle must match full-window math of
    // the rebuilt slice, not the previous in-memory state.
    const rebuilt = fixture.slice(0, 25);
    await computer.rebuild('BTCUSDT', '1h', rebuilt);
    const bundle = readBundle(redis);

    // After rebuild, state is re-seeded from `rebuilt` — assert against
    // the incremental-package shadow over the same slice.
    const seedSma = incrementalSMA(20).initFromWindow(rebuilt);
    const seedEma = incrementalEMA(20).initFromWindow(rebuilt);
    const seedRsi = incrementalRSI(14).initFromWindow(rebuilt);
    expect(bundle.sma20).toBe(incrementalSMA(20).currentValue(seedSma).toFixed());
    expect(bundle.ema20).toBe(incrementalEMA(20).currentValue(seedEma).toFixed());
    expect(bundle.rsi14).toBe(incrementalRSI(14).currentValue(seedRsi).toFixed());

    // SMA equivalence with the full-window form still holds (window-local).
    expect(bundle.sma20).toBe(fullSma(rebuilt, 20).toFixed());

    // Subsequent recompute folds candle index 25 into the rebuilt state.
    const [, smaAfter] = incrementalSMA(20).update(seedSma, fixture[25] as Candle);
    const [, emaAfter] = incrementalEMA(20).update(seedEma, fixture[25] as Candle);
    const [, rsiAfter] = incrementalRSI(14).update(seedRsi, fixture[25] as Candle);
    await computer.recompute('BTCUSDT', '1h', { ...(fixture[25] as Candle) });
    const next = readBundle(redis);
    expect(next.sma20).toBe(smaAfter.toFixed());
    expect(next.ema20).toBe(emaAfter.toFixed());
    expect(next.rsi14).toBe(rsiAfter.toFixed());
  });

  it('produces null indicator values while the window is below threshold', async () => {
    const redis = stubRedis();
    const computer = createTestComputer(redis, { logger: silentLogger, windowSize: 50 });
    const fixture = buildFixture(14);

    for (const c of fixture) {
      await computer.recompute('BTCUSDT', '1h', { ...c });
    }
    const bundle = readBundle(redis);
    expect(bundle.sma20).toBeNull();
    expect(bundle.ema20).toBeNull();
    expect(bundle.rsi14).toBeNull();
    expect(bundle.windowSize).toBe(14);
  });

  it('restart restores state from Redis and continues with EMA/RSI byte-equal to no-restart', async () => {
    const redis = stubRedis();
    const windowSize = 50;
    const fixture = buildFixture(60);

    // No-restart shadow: stream all 60 candles through one computer.
    const shadowRedis = stubRedis();
    const shadow = createTestComputer(shadowRedis, { logger: silentLogger, windowSize });
    for (const c of fixture) {
      await shadow.recompute('BTCUSDT', '1h', { ...c });
    }
    const shadowBundle = JSON.parse(shadowRedis.kvs.get('indicators:BTCUSDT:1h') as string) as {
      sma20: string;
      ema20: string;
      rsi14: string;
    };

    // Restart path: stream the first 30 candles through computer A, then
    // construct computer B (sharing the same Redis) and stream the rest.
    const a = createTestComputer(redis, { logger: silentLogger, windowSize });
    for (const c of fixture.slice(0, 30)) {
      await a.recompute('BTCUSDT', '1h', { ...c });
    }
    const b = createTestComputer(redis, { logger: silentLogger, windowSize });
    for (const c of fixture.slice(30)) {
      await b.recompute('BTCUSDT', '1h', { ...c });
    }
    const final = readBundle(redis);
    expect(final.sma20).toBe(shadowBundle.sma20);
    expect(final.ema20).toBe(shadowBundle.ema20);
    expect(final.rsi14).toBe(shadowBundle.rsi14);
  });

  it('clear removes in-memory + Redis state; subsequent recompute re-seeds from window', async () => {
    const redis = stubRedis();
    const computer = createTestComputer(redis, { logger: silentLogger, windowSize: 50 });
    const fixture = buildFixture(40);

    for (const c of fixture.slice(0, 30)) {
      await computer.recompute('BTCUSDT', '1h', { ...c });
    }
    // State persisted to Redis after the loop above.
    expect(redis.kvs.has('indicatorState:BTCUSDT:1h:sma:20')).toBe(true);
    expect(redis.kvs.has('indicatorState:BTCUSDT:1h:ema:20')).toBe(true);
    expect(redis.kvs.has('indicatorState:BTCUSDT:1h:rsi:14')).toBe(true);

    await computer.clear('BTCUSDT', '1h');
    expect(redis.kvs.has('indicatorState:BTCUSDT:1h:sma:20')).toBe(false);
    expect(redis.kvs.has('indicatorState:BTCUSDT:1h:ema:20')).toBe(false);
    expect(redis.kvs.has('indicatorState:BTCUSDT:1h:rsi:14')).toBe(false);

    // Subsequent recompute re-seeds from the ZSET (which still contains
    // the last 30 closed candles). State must be re-populated.
    await computer.recompute('BTCUSDT', '1h', { ...(fixture[30] as Candle) });
    expect(redis.kvs.has('indicatorState:BTCUSDT:1h:sma:20')).toBe(true);
  });

  it('corrupt Redis state blob falls through to window cold-seed without throwing', async () => {
    const redis = stubRedis();
    const computer = createTestComputer(redis, { logger: silentLogger, windowSize: 50 });
    const fixture = buildFixture(30);
    // Pre-populate the SMA state key with malformed JSON.
    redis.kvs.set('indicatorState:BTCUSDT:1h:sma:20', '{not-json');
    for (const c of fixture) {
      await computer.recompute('BTCUSDT', '1h', { ...c });
    }
    const bundle = readBundle(redis);
    // SMA must still be defined after enough candles — the cold-seed-from-window
    // path took over.
    expect(bundle.sma20).not.toBeNull();
  });

  it('bundle stays defined when port loadWindow returns a window shorter than SMA period', async () => {
    // Cold-start window: port has only 5 candles, well below SMA_PERIOD=20.
    // The bundle must still render (lowestLow/highestHigh from any non-empty
    // window) with the per-indicator value fields left null until the window
    // grows past each indicator's minimum. No crash, no negative-index slice.
    const redis = stubRedis();
    const computer = createTestComputer(redis, { logger: silentLogger, windowSize: 50 });
    const fixture = buildFixture(5);
    for (const c of fixture) {
      await computer.recompute('BTCUSDT', '1h', { ...c });
    }
    const bundle = readBundle(redis);
    expect(bundle.sma20).toBeNull();
    expect(bundle.ema20).toBeNull();
    expect(bundle.rsi14).toBeNull();
    expect(bundle.windowSize).toBe(5);
  });

  it('writes the ATH key from the window high on a 1d close, and only on 1d', async () => {
    const redis = stubRedis();
    const computer = createTestComputer(redis, { logger: silentLogger, windowSize: 50 });
    const fixture = buildFixture(30);

    // A 1h close must not touch the ATH key — guards the conditional-spread
    // negative branch so an inverted ternary would fail here.
    await computer.recompute('BTCUSDT', '1h', { ...(fixture[0] as Candle) });
    expect(redis.kvs.has(athKey('BTCUSDT'))).toBe(false);

    // A 1d close writes ath:<symbol> = the highest high across the window.
    for (const c of fixture) {
      await computer.recompute('BTCUSDT', '1d', { ...c });
    }
    // The ring holds all 30 candles (< windowSize + 1), so the window is the
    // full fixture and the ATH is its max high.
    expect(redis.kvs.get(athKey('BTCUSDT'))).toBe(ath(fixture).toFixed());
  });

  it('per-symbol state stays isolated', async () => {
    const redis = stubRedis();
    const computer = createTestComputer(redis, { logger: silentLogger, windowSize: 50 });
    const fixture = buildFixture(30);

    for (const c of fixture) {
      await computer.recompute('BTCUSDT', '1h', { ...c });
      await computer.recompute('ETHUSDT', '1h', { ...c, close: (Number(c.close) * 2).toString() });
    }
    const btcRaw = redis.kvs.get('indicators:BTCUSDT:1h');
    const ethRaw = redis.kvs.get('indicators:ETHUSDT:1h');
    if (!btcRaw || !ethRaw) throw new Error('expected both symbol bundles to be written');
    const btc = JSON.parse(btcRaw) as { sma20: string };
    const eth = JSON.parse(ethRaw) as { sma20: string };
    expect(btc.sma20).not.toBe(eth.sma20);
  });
});
