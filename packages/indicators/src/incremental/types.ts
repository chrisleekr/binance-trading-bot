// Incremental indicator contract.
//
// Each indicator owns a typed `TState` and a typed `TValue`. The state holds
// just enough tail-state to fold the next closed candle in O(1); the value is
// the indicator output at the just-folded candle.
//
// Usage:
//
//   const ind = incrementalEMA(50);
//   let state = ind.initFromWindow(window);
//   for (const nextCandle of stream) {
//     let value: Decimal;
//     [state, value] = ind.update(state, nextCandle);
//   }
//
// The split between `initFromWindow` and `update` is what gives the
// constant-time steady state: the warm-up cost is paid exactly once at boot
// (or after a worker restart), then every subsequent closed candle folds in
// O(1).

import type { Candle } from '@app/strategy-core';
import type { CandleWindow } from '@app/indicators';

/** Stable identifier so persisted state in Redis is keyed unambiguously. */
export type IndicatorId = string;

export interface IncrementalIndicator<TState, TValue> {
  /** Stable identifier; used as the persistence key. */
  readonly id: IndicatorId;
  /**
   * Seed state from a warm window. Throws when the window is too short to
   * initialise (e.g. EMA(20) needs >= 20 candles). The returned state must
   * be sufficient to drive subsequent `update` calls with no further window
   * access.
   */
  readonly initFromWindow: (window: CandleWindow) => TState;
  /**
   * Fold one closed candle into state. Returns the next state and the
   * indicator value at that candle. Pure: must not mutate the input state.
   */
  readonly update: (state: TState, next: Candle) => readonly [TState, TValue];
  /**
   * Read the indicator value from state without folding a candle. Used by
   * cold-seed paths that init from a window already containing the latest
   * closed candle and need the indicator's value at that candle without
   * double-folding it via `update`.
   */
  readonly currentValue: (state: TState) => TValue;
  /**
   * Encode state to a JSON-safe string. Each indicator maps its `Decimal`
   * fields to decimal-strings (full precision via `Decimal#toString`); the
   * resulting blob is what the persistence layer writes to Redis.
   *
   * Throwing from `serialize` is a programmer error — only well-formed
   * state shapes reach this seam.
   */
  readonly serialize: (state: TState) => string;
  /**
   * Decode a previously serialised state. Throws on malformed input so a
   * corrupt blob fails loudly at boot rather than silently producing
   * garbage values downstream.
   */
  readonly deserialize: (raw: string) => TState;
}
