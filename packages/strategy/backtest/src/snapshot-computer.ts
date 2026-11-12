// Stateful per-(symbol, interval) indicator-snapshot computer for one backtest run. It carries each incremental indicator's O(1) state forward across ticks, folding only the candles closed since the previous call, as the live indicator-computer does (apps/worker/.../indicator-computer.ts), instead of re-seeding the whole rolling window on every tick.
//
// Why: re-seeding `sma20`/`ema20`/`rsi14` from the full window each tick was the
// single dominant per-tick cost of a backtest. Carrying state makes it O(1). The
// `lowestLow`/`highestHigh` fields were the remaining per-tick full scan; a
// monotonic deque folds them in O(1) amortised too, so the whole snapshot is now
// O(1) per tick rather than O(window).
//
// Parity: while a window only grows (never reaches the engine's `WINDOW_CAP`),
// `update`-folding the new candle yields the SAME value as `initFromWindow` over
// the whole window — the folds are identical in order — so short runs and the
// golden fixture are byte-identical to the old re-seed. Once the window starts to
// slide, the carried value keeps all history (like live) while the old re-seed
// dropped candles older than the cap, so long runs converge to live's value
// instead of the cap-truncated one. This is the documented seed-equivalence of
// the incremental indicators, now used the way live uses it.

import { Decimal } from '@app/money';
import type { CandleWindow } from '@app/indicators';
import {
  incrementalEMA,
  incrementalRSI,
  incrementalSMA,
  type EMAState,
  type IncrementalIndicator,
  type RSIState,
  type SMAState,
} from '@app/indicators/incremental';
import type { Candle, IndicatorSnapshot } from '@app/strategy-core';

// Periods the live indicator pipeline uses; the snapshot field names
// (sma20/ema20/rsi14) encode them. RSI needs period+1 candles for its first
// delta, hence the +1 minimum window.
const SMA_PERIOD = 20;
const EMA_PERIOD = 20;
const RSI_PERIOD = 14;
const RSI_MIN_WINDOW = RSI_PERIOD + 1;

interface ToFixed {
  toFixed(): string;
}

// Mirrors the live indicator-computer's stepOrSeed: fold each candle newer than the last close into existing state, else cold-seed from the window, which already contains them, so `currentValue` reads it without a double-fold. Stays null until the window is long enough, the same null path live uses.
const stepOrSeed = <S, V extends ToFixed>(
  state: S | null,
  window: CandleWindow,
  minWindow: number,
  ind: IncrementalIndicator<S, V>,
  newer: readonly Candle[],
): { state: S | null; value: string | null } => {
  if (state !== null) {
    let next: S = state;
    let value: string | null = null;
    for (const candle of newer) {
      const [advanced, latest] = ind.update(next, candle);
      next = advanced;
      value = latest.toFixed();
    }
    return { state: next, value };
  }
  if (window.length < minWindow) return { state: null, value: null };
  const seeded = ind.initFromWindow(window);
  return { state: seeded, value: ind.currentValue(seeded).toFixed() };
};

interface MonoEntry {
  readonly closeTimeMs: number;
  readonly value: Decimal;
}

interface RollingExtremum {
  /**
   * Fold one candle's value, then drop the at-most-one entry that slid out of
   * the window this tick (`closeTimeMs < oldestInWindow`). The front then holds
   * the window extremum, byte-identical to a full `lowestLow`/`highestHigh`
   * scan of the same window.
   */
  fold: (closeTimeMs: number, value: Decimal, oldestInWindowMs: number) => void;
  /** Current window extremum. Precondition: at least one candle folded. */
  value: () => Decimal;
}

/**
 * O(1)-amortised rolling-window min/max via a monotonic deque. `dominated(back,
 * incoming)` returns true when the existing back entry can never again be the
 * extremum while `incoming` is in the window, so it is popped: `back >= incoming`
 * for a rolling MIN, `back <= incoming` for a rolling MAX.
 *
 * Front eviction uses a head index, not `Array.shift`: a slid-out candle is at
 * the front, and `shift` on a deque that grows to the window size (a monotonic
 * price run) would be O(window), reintroducing the very per-tick scan this
 * removes. The dead prefix is reclaimed once it dominates the array so memory
 * stays bounded by the live window, not the whole run.
 */
const createRollingExtremum = (
  dominated: (back: Decimal, incoming: Decimal) => boolean,
): RollingExtremum => {
  let entries: MonoEntry[] = [];
  let head = 0;
  return {
    fold(closeTimeMs, value, oldestInWindowMs) {
      while (entries.length > head) {
        const back = entries[entries.length - 1];
        if (back === undefined || !dominated(back.value, value)) break;
        entries.pop();
      }
      entries.push({ closeTimeMs, value });
      while (head < entries.length) {
        const front = entries[head];
        if (front === undefined || front.closeTimeMs >= oldestInWindowMs) break;
        head++;
      }
      if (head > 32 && head * 2 >= entries.length) {
        entries = entries.slice(head);
        head = 0;
      }
    },
    value() {
      const front = entries[head];
      if (front === undefined) throw new Error('rolling extremum read before any fold');
      return front.value;
    },
  };
};

interface KeyState {
  sma: SMAState | null;
  ema: EMAState | null;
  rsi: RSIState | null;
  low: RollingExtremum;
  high: RollingExtremum;
  lastCloseTimeMs: number;
  snapshot: IndicatorSnapshot | null;
}

interface SnapshotComputer {
  /**
   * The {@link IndicatorSnapshot} for `key`'s latest closed candle, carrying the indicator state forward. Returns the previous snapshot unchanged when `window`'s last candle has the same close time as the previous call for this key: an interval whose candle has not advanced across many ticks, so folding it again would double-count it.
   *
   * Every candle closed since the previous call for this key is folded in order, so a 1-minute window read every five minutes advances by five bars. A window that no longer reaches the previous close has no contiguous candles to fold, so it cold-seeds.
   *
   * @param key - The (symbol, interval) the state belongs to.
   * @param window - Closed candles ascending by close time, ending at the latest closed candle.
   * @returns The snapshot for that candle, or null for an empty window.
   */
  step(key: string, window: CandleWindow): IndicatorSnapshot | null;
}

export const createSnapshotComputer = (): SnapshotComputer => {
  const smaInd = incrementalSMA(SMA_PERIOD);
  const emaInd = incrementalEMA(EMA_PERIOD);
  const rsiInd = incrementalRSI(RSI_PERIOD);
  const states = new Map<string, KeyState>();

  return {
    step(key, window) {
      if (window.length === 0) return null;
      const closed = window[window.length - 1];
      if (!closed) return null;

      const stored = states.get(key);
      // Same closed candle as last call: the interval has not advanced (an aux
      // window unchanged across intra-interval ticks). Return the cached value
      // rather than folding the same candle into the indicator state twice.
      if (stored && stored.lastCloseTimeMs === closed.closeTimeMs) return stored.snapshot;

      const oldest = window[0];
      if (oldest === undefined) return null; // unreachable: window is non-empty here
      const prior = stored && oldest.closeTimeMs <= stored.lastCloseTimeMs ? stored : undefined;
      let newerFrom = window.length;
      while (
        newerFrom > 0 &&
        (window[newerFrom - 1]?.closeTimeMs ?? 0) > (prior?.lastCloseTimeMs ?? -Infinity)
      )
        newerFrom--;
      const newer = window.slice(newerFrom);

      const sma = stepOrSeed(prior?.sma ?? null, window, SMA_PERIOD, smaInd, newer);
      const ema = stepOrSeed(prior?.ema ?? null, window, EMA_PERIOD, emaInd, newer);
      const rsi = stepOrSeed(prior?.rsi ?? null, window, RSI_MIN_WINDOW, rsiInd, newer);

      // High/low carry the same way: cold-seed folds the whole window once, then later calls fold only the newer candles.
      const oldestInWindowMs = oldest.closeTimeMs;
      const low =
        prior?.low ??
        createRollingExtremum((back, incoming) => back.greaterThanOrEqualTo(incoming));
      const high =
        prior?.high ?? createRollingExtremum((back, incoming) => back.lessThanOrEqualTo(incoming));
      for (const c of newer) {
        low.fold(c.closeTimeMs, new Decimal(c.low), oldestInWindowMs);
        high.fold(c.closeTimeMs, new Decimal(c.high), oldestInWindowMs);
      }

      const snapshot: IndicatorSnapshot = {
        windowSize: window.length,
        lowestLow: low.value().toFixed(),
        highestHigh: high.value().toFixed(),
        sma20: sma.value,
        ema20: ema.value,
        rsi14: rsi.value,
        lastCandleCloseTimeMs: closed.closeTimeMs,
      };
      states.set(key, {
        sma: sma.state,
        ema: ema.state,
        rsi: rsi.state,
        low,
        high,
        lastCloseTimeMs: closed.closeTimeMs,
        snapshot,
      });
      return snapshot;
    },
  };
};
