import { highestHigh, lowestLow, type CandleWindow } from '@app/indicators';
import { incrementalEMA, incrementalRSI, incrementalSMA } from '@app/indicators/incremental';
import type { IndicatorSnapshot } from '@app/strategy-core';

// Periods the live indicator pipeline uses; the snapshot field names
// (sma20/ema20/rsi14) encode them. RSI needs period+1 candles for its first
// delta, hence the +1 minimum window.
const SMA_PERIOD = 20;
const EMA_PERIOD = 20;
const RSI_PERIOD = 14;
const RSI_MIN_WINDOW = RSI_PERIOD + 1;

/**
 * The per-interval {@link IndicatorSnapshot} computed by re-seeding the whole
 * window (`initFromWindow`). This is the full-window REFERENCE definition: the
 * engine loop itself now uses the stateful `createSnapshotComputer`, which
 * carries the incremental state forward one candle at a time (O(1) per tick, like
 * the live worker) instead of re-seeding every tick. `snapshot-computer.test.ts`
 * verifies the carried value is byte-identical to this reference while the window
 * only grows; once the window slides past the engine's cap they diverge (the
 * carried value keeps all history, like live; this reference drops the tail).
 *
 * Byte-equivalence comes from the seed-equivalence of the incremental indicators:
 * `initFromWindow(window)` over the candles seen so far yields the same value the
 * computer reaches by folding candles one at a time. The parity gate verifies
 * the indicators end-to-end. A field is null when the window is shorter than the
 * indicator's minimum, exactly as live.
 */
export function computeIndicatorSnapshot(window: CandleWindow): IndicatorSnapshot | null {
  if (window.length === 0) return null;
  const closed = window[window.length - 1];
  if (!closed) return null;
  return {
    windowSize: window.length,
    lowestLow: lowestLow(window).toFixed(),
    highestHigh: highestHigh(window).toFixed(),
    sma20: seededValue(window, SMA_PERIOD, () => incrementalSMA(SMA_PERIOD)),
    ema20: seededValue(window, EMA_PERIOD, () => incrementalEMA(EMA_PERIOD)),
    rsi14: seededValue(window, RSI_MIN_WINDOW, () => incrementalRSI(RSI_PERIOD)),
    lastCandleCloseTimeMs: closed.closeTimeMs,
  };
}

/**
 * Seed an incremental indicator from the window and read its value at the
 * latest candle, or null when the window is too short — mirroring the live
 * computer's `state === null && window < minWindow` null path.
 */
function seededValue<S, V extends { toFixed(): string }>(
  window: CandleWindow,
  minWindow: number,
  make: () => { initFromWindow: (w: CandleWindow) => S; currentValue: (s: S) => V },
): string | null {
  if (window.length < minWindow) return null;
  const ind = make();
  return ind.currentValue(ind.initFromWindow(window)).toFixed();
}
