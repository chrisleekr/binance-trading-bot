// IndicatorComputer: push-based indicators on kline-close.
//
// Cold-start REST budget: the production port (`KlineFetcher`) fires a
// best-effort REST cold-load on first subscribe that fills the ring up to
// `ringSize` — by the time the first closed-candle event
// reaches `recompute` the ring usually holds the whole window. If the
// cold-load races with the first WS frame the ring may be short of
// `windowSize`; `port.loadWindow` then REST-falls-back (weight-governed by
// the same governor the cold-load reserves against). The cost is bounded:
// one extra REST per (symbol, interval) per worker boot in the worst case.
//
// On every closed candle:
//   1. Pull the latest closed-kline window via `port.loadWindow(symbol,
//      interval, size)`. The KlineFetcher's per-(symbol, interval) ring is
//      populated by the WS subscriber before the closed candle fans out to
//      this handler, so the window already includes the just-closed candle;
//      the port REST-falls-back (weight-governed) when the ring is short of
//      `size`.
//   2. Fold the just-closed candle into per-(symbol, interval) incremental
//      indicator state (cold-loads from the window on first call per key).
//   3. SET indicators:<symbol>:<interval> with the bundle.
//   4. If interval === '1d' → SET ath:<symbol> = max(window-high).
//
// Indicator state lives in-memory across `recompute` calls; on cold start
// the first `recompute` per key attempts to rehydrate from Redis
// (`indicatorState:*`), falling through to a window seed on miss or corrupt
// blob. After each successful update, state is serialised back to Redis so
// a worker restart preserves the running EMA/RSI value across the boot
// boundary. The candle window itself is NOT persisted — the port's ring
// (in-memory) plus its REST cold-load on next subscribe re-populate it.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { Candle, IndicatorSnapshot } from '@app/strategy-core';
import { GLOBAL_KEYS } from '@app/db';
import { ath, highestHigh, lowestLow } from '@app/indicators';
import {
  incrementalSMA,
  incrementalEMA,
  incrementalRSI,
  type IncrementalIndicator,
  type SMAState,
  type EMAState,
  type RSIState,
} from '@app/indicators/incremental';
import type { ClosedCandle, IndicatorComputerHook } from 'event-router/event-router.js';

/**
 * Read the latest closed-kline window for `(symbol, interval)`. The
 * production binding routes to `MarketDataPort.loadWindow` (KlineFetcher
 * ring + weight-governed REST fallback). A function rather than the full
 * port keeps the dependency surface narrow and lets boot-context bind it
 * lazily through a ref — the port is constructed after this computer in
 * the boot order.
 */
export type LoadCandleWindow = (
  symbol: string,
  interval: string,
  size: number,
) => Promise<readonly Candle[]>;

// The Redis payload is the strategy-facing IndicatorSnapshot plus the
// symbol/interval coordinates. Extending the contract type keeps the
// producer's field set in lock-step with what strategies consume.
export interface IndicatorBundle extends IndicatorSnapshot {
  readonly symbol: string;
  readonly interval: string;
}

export interface IndicatorComputerOptions {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly loadWindow: LoadCandleWindow;
  readonly windowSize?: number;
  readonly indicatorTtlSeconds?: number;
  readonly athTtlSeconds?: number;
}

export interface IndicatorComputer extends IndicatorComputerHook {
  /**
   * Cold-start path: recompute the bundle from the supplied candles array.
   * `candles` is treated as the authoritative window (caller-trimmed if
   * over `windowSize`); the port's ring is the long-lived store, so no
   * Redis ZSET write happens here. Cold-start seeding currently flows through
   * the event-router's `recompute` on the first closed kline, so this has no
   * production caller today; it stays as the supported cold-rebuild entry point.
   */
  rebuild(symbol: string, interval: string, candles: readonly Candle[]): Promise<void>;
  /**
   * Drop all state for (symbol, interval): in-memory + Redis indicator
   * state. Called from the unsubscribe path so a no-longer-active key
   * does not leak state forever. Idempotent — safe to call on a key
   * that was never seeded.
   */
  clear(symbol: string, interval: string): Promise<void>;
}

const DEFAULT_WINDOW = 200;
const DEFAULT_TTL = 24 * 60 * 60;

const SMA_PERIOD = 20;
const EMA_PERIOD = 20;
const RSI_PERIOD = 14;
const RSI_MIN_WINDOW = RSI_PERIOD + 1; // 15 — same threshold the old code used

export const indicatorKey = (symbol: string, interval: string): string =>
  `indicators:${symbol}:${interval}`;

export const athKey = (symbol: string): string => `ath:${symbol}`;

// Per-(symbol, interval) incremental state for the three running indicators.
// `null` entries denote "window too short to seed" — kept null until the
// window grows past the minimum so the bundle field stays null (matching
// the previous behaviour).
interface IndicatorState {
  sma: SMAState | null;
  ema: EMAState | null;
  rsi: RSIState | null;
}

const stateKey = (symbol: string, interval: string): string => `${symbol}:${interval}`;

// Fold the just-closed candle into one indicator's state. On the cold-seed
// path `initFromWindow(window)` seeds from the full window (which already
// contains the just-closed candle); `currentValue(state)` reads the value
// at that candle without double-folding via `update`. Steady-state takes
// the `update` path. Returns `(null, null)` when the window is too short
// to seed; the bundle field stays null, matching the previous behaviour.
// Worker code shouldn't import `decimal.js` directly (banned outside the
// money-math packages). The value's only worker-side use is its `toFixed`
// string form, so the helper is generic over a structural shape that
// covers `Decimal`.
interface ToFixed {
  toFixed(): string;
}

const stepOrSeed = <S, V extends ToFixed>(
  state: S | null,
  window: readonly Candle[],
  minWindow: number,
  ind: IncrementalIndicator<S, V>,
  closed: Candle,
): { state: S | null; value: string | null } => {
  if (state !== null) {
    const [next, value] = ind.update(state, closed);
    return { state: next, value: value.toFixed() };
  }
  if (window.length < minWindow) return { state: null, value: null };
  const seeded = ind.initFromWindow(window);
  return { state: seeded, value: ind.currentValue(seeded).toFixed() };
};

export const createIndicatorComputer = (opts: IndicatorComputerOptions): IndicatorComputer => {
  const windowSize = opts.windowSize ?? DEFAULT_WINDOW;
  const indicatorTtl = opts.indicatorTtlSeconds ?? DEFAULT_TTL;
  const athTtl = opts.athTtlSeconds ?? DEFAULT_TTL;
  const loadWindow = opts.loadWindow;

  const smaInd = incrementalSMA(SMA_PERIOD);
  const emaInd = incrementalEMA(EMA_PERIOD);
  const rsiInd = incrementalRSI(RSI_PERIOD);

  // Per-(symbol, interval) running state. Survives across recompute calls
  // for the same key; rehydrated from Redis on first access and re-seeded
  // from the port window on a corrupt blob.
  const states = new Map<string, IndicatorState>();

  // Load `state.<field>` from Redis if a serialised blob exists. Per
  // indicator: HIT keeps the field non-null and skips the cold-seed branch
  // for that indicator on the next recompute. MISS or CORRUPT keeps the
  // field null and logs a warn so the cold-seed-from-window path runs.
  const tryRehydrate = async <S>(
    symbol: string,
    interval: string,
    ind: IncrementalIndicator<S, unknown>,
  ): Promise<S | null> => {
    const k = GLOBAL_KEYS.indicatorState(symbol, interval, ind.id);
    try {
      const raw = await opts.redis.get(k);
      if (raw === null) return null;
      return ind.deserialize(raw);
    } catch (err) {
      opts.logger.warn(
        { symbol, interval, indicatorId: ind.id, err: err },
        'indicator-computer: corrupt indicator-state blob; will re-seed from window',
      );
      return null;
    }
  };

  // First access for `key` after boot or after `rebuild`: try Redis for
  // each of the three indicators in parallel; whatever rehydrates skips
  // the cold-seed branch on the next recompute.
  const loadStateFromRedis = async (symbol: string, interval: string): Promise<IndicatorState> => {
    const [sma, ema, rsi] = await Promise.all([
      tryRehydrate(symbol, interval, smaInd),
      tryRehydrate(symbol, interval, emaInd),
      tryRehydrate(symbol, interval, rsiInd),
    ]);
    return { sma, ema, rsi };
  };

  const getOrInitState = async (symbol: string, interval: string): Promise<IndicatorState> => {
    const key = stateKey(symbol, interval);
    let s = states.get(key);
    if (!s) {
      s = await loadStateFromRedis(symbol, interval);
      states.set(key, s);
    }
    return s;
  };

  const resetState = (symbol: string, interval: string): IndicatorState => {
    const s: IndicatorState = { sma: null, ema: null, rsi: null };
    states.set(stateKey(symbol, interval), s);
    return s;
  };

  // Best-effort persistence — a Redis write failure must not fail the
  // recompute (the in-memory state already advanced). Log at warn and
  // continue; the next successful update overwrites the stale blob.
  const persistState = async (
    symbol: string,
    interval: string,
    state: IndicatorState,
  ): Promise<void> => {
    const writes: Promise<unknown>[] = [];
    if (state.sma !== null) {
      writes.push(
        opts.redis.set(
          GLOBAL_KEYS.indicatorState(symbol, interval, smaInd.id),
          smaInd.serialize(state.sma),
          'EX',
          indicatorTtl,
        ),
      );
    }
    if (state.ema !== null) {
      writes.push(
        opts.redis.set(
          GLOBAL_KEYS.indicatorState(symbol, interval, emaInd.id),
          emaInd.serialize(state.ema),
          'EX',
          indicatorTtl,
        ),
      );
    }
    if (state.rsi !== null) {
      writes.push(
        opts.redis.set(
          GLOBAL_KEYS.indicatorState(symbol, interval, rsiInd.id),
          rsiInd.serialize(state.rsi),
          'EX',
          indicatorTtl,
        ),
      );
    }
    try {
      await Promise.all(writes);
    } catch (err) {
      opts.logger.warn(
        { symbol, interval, err: err },
        'indicator-computer: failed to persist state; next recompute will overwrite',
      );
    }
  };

  const deleteRedisState = async (symbol: string, interval: string): Promise<void> => {
    await opts.redis.del(
      GLOBAL_KEYS.indicatorState(symbol, interval, smaInd.id),
      GLOBAL_KEYS.indicatorState(symbol, interval, emaInd.id),
      GLOBAL_KEYS.indicatorState(symbol, interval, rsiInd.id),
    );
  };

  const computeBundle = (
    symbol: string,
    interval: string,
    window: readonly Candle[],
    closed: Candle,
    state: IndicatorState,
  ): IndicatorBundle | null => {
    if (window.length === 0) return null;
    const sma = stepOrSeed(state.sma, window, SMA_PERIOD, smaInd, closed);
    const ema = stepOrSeed(state.ema, window, EMA_PERIOD, emaInd, closed);
    const rsi = stepOrSeed(state.rsi, window, RSI_MIN_WINDOW, rsiInd, closed);
    state.sma = sma.state;
    state.ema = ema.state;
    state.rsi = rsi.state;
    return {
      symbol,
      interval,
      windowSize: window.length,
      lowestLow: lowestLow(window).toFixed(),
      highestHigh: highestHigh(window).toFixed(),
      sma20: sma.value,
      ema20: ema.value,
      rsi14: rsi.value,
      lastCandleCloseTimeMs: closed.closeTimeMs,
    };
  };

  const writeBundle = async (bundle: IndicatorBundle): Promise<void> => {
    await opts.redis.set(
      indicatorKey(bundle.symbol, bundle.interval),
      JSON.stringify(bundle),
      'EX',
      indicatorTtl,
    );
  };

  return {
    async recompute(symbol, interval, candle: ClosedCandle) {
      const stored: Candle = {
        openTimeMs: candle.openTimeMs,
        closeTimeMs: candle.closeTimeMs,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        isClosed: true,
      };
      // The port's ring is updated by the WS subscriber before the closed
      // candle fans out to the event-router (kline-fetcher: `fanOut`
      // pushes to `state.ring` then notifies subscribers), so the loaded
      // window already includes `candle`. REST fallback (weight-governed)
      // covers the cold-start case where the ring has fewer than `size`
      // entries.
      const window = await loadWindow(symbol, interval, windowSize);
      const state = await getOrInitState(symbol, interval);
      const bundle = computeBundle(symbol, interval, window, stored, state);
      if (!bundle) return;
      // Up to three independent writes to distinct keyspaces: the bundle blob,
      // the persisted state (itself a batched 0-to-3 SET), and — on the 1d close
      // only — the ATH key. Issue them together so a candle-close pays one
      // pipelined round-trip, not one per write in series.
      await Promise.all([
        writeBundle(bundle),
        persistState(symbol, interval, state),
        ...(interval === '1d'
          ? [opts.redis.set(athKey(symbol), ath(window).toFixed(), 'EX', athTtl)]
          : []),
      ]);
    },
    async rebuild(symbol, interval, candles) {
      const trimmed = candles.slice(-windowSize);
      // Rebuild resets per-key indicator state; the persisted blob is
      // overwritten by the fresh `persistState` below, removing the race
      // window where a mid-rebuild crash could leave new in-memory state
      // alongside the previous Redis blob.
      const state = resetState(symbol, interval);
      const last = trimmed.at(-1);
      if (!last) {
        // No candles to compute against — make sure the stale Redis blob
        // doesn't outlive the rebuild that explicitly meant to drop state.
        await deleteRedisState(symbol, interval).catch((err: unknown) => {
          opts.logger.warn(
            { symbol, interval, err: err },
            'indicator-computer: failed to delete state on empty rebuild',
          );
        });
        return;
      }
      const closed: Candle = { ...last, isClosed: true };
      const bundle = computeBundle(symbol, interval, trimmed, closed, state);
      if (!bundle) return;
      await writeBundle(bundle);
      await persistState(symbol, interval, state);
      if (interval === '1d') {
        await opts.redis.set(athKey(symbol), ath(trimmed).toFixed(), 'EX', athTtl);
      }
    },
    async clear(symbol, interval) {
      states.delete(stateKey(symbol, interval));
      await deleteRedisState(symbol, interval);
    },
  };
};
