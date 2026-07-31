// Stateful per-(symbol, interval) indicator-snapshot computer for one backtest
// run. It carries each incremental indicator's O(1) state forward across ticks —
// folding only the just-closed candle — exactly as the live indicator-computer
// does (apps/worker/.../indicator-computer.ts), instead of re-seeding the whole
// rolling window on every tick.
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

// Mirrors the live indicator-computer's stepOrSeed: fold the just-closed candle
// into existing state, else cold-seed from the window (which already contains
// that candle, so `currentValue` reads it without a double-fold). Stays null
// until the window is long enough — the same null path live uses.
const stepOrSeed = <S, V extends ToFixed>(
  state: S | null,
  window: CandleWindow,
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
   * The {@link IndicatorSnapshot} for `key`'s latest closed candle, carrying the
   * indicator state forward. Returns the previous snapshot unchanged when
   * `window`'s last candle has the same close time as the previous call for this
   * key — an auxiliary (e.g. daily) interval whose candle has not advanced across
   * many intra-interval ticks, so folding it again would double-count it.
   *
   * Precondition: once seeded, each subsequent call for the same key must advance
   * the window by exactly one closed candle (the steady state `update` folds only
   * the latest candle). The engine loop satisfies this — it appends one candle per
   * tick — and an aux interval advances by one candle per close (the caching above
   * collapses the unchanged ticks in between). This mirrors the live computer,
   * which is likewise called once per closed candle.
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

      const prior = states.get(key);
      // Same closed candle as last call: the interval has not advanced (an aux
      // window unchanged across intra-interval ticks). Return the cached value
      // rather than folding the same candle into the indicator state twice.
      if (prior && prior.lastCloseTimeMs === closed.closeTimeMs) return prior.snapshot;

      const sma = stepOrSeed(prior?.sma ?? null, window, SMA_PERIOD, smaInd, closed);
      const ema = stepOrSeed(prior?.ema ?? null, window, EMA_PERIOD, emaInd, closed);
      const rsi = stepOrSeed(prior?.rsi ?? null, window, RSI_MIN_WINDOW, rsiInd, closed);

      // High/low carry the same way: cold-seed folds the whole window once, then
      // each later tick folds only the new candle (the engine advances by one
      // candle per tick; the dedup above collapses unchanged aux ticks).
      const oldest = window[0];
      if (oldest === undefined) return null; // unreachable: window is non-empty here
      const oldestInWindowMs = oldest.closeTimeMs;
      let low: RollingExtremum;
      let high: RollingExtremum;
      if (prior) {
        ({ low, high } = prior);
        low.fold(closed.closeTimeMs, new Decimal(closed.low), oldestInWindowMs);
        high.fold(closed.closeTimeMs, new Decimal(closed.high), oldestInWindowMs);
      } else {
        low = createRollingExtremum((back, incoming) => back.greaterThanOrEqualTo(incoming));
        high = createRollingExtremum((back, incoming) => back.lessThanOrEqualTo(incoming));
        for (const c of window) {
          low.fold(c.closeTimeMs, new Decimal(c.low), oldestInWindowMs);
          high.fold(c.closeTimeMs, new Decimal(c.high), oldestInWindowMs);
        }
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
