import type { Candle } from '@app/strategy-core';

/**
 * Minimal read/write surface a backtest run needs to reuse a loaded candle
 * window. `Map` satisfies it structurally, so a single ad-hoc run can still
 * pass a plain `Map`; the shared process-level cache below implements the same
 * surface with a bound.
 */
export interface CandleCache {
  get(key: string): Candle[] | undefined;
  set(key: string, value: Candle[]): void;
}

// The source candle window for a (symbol, interval, range) is config-independent:
// separate backtest runs over the SAME candles with only the strategy config
// varying otherwise each re-read the range from Postgres and rebuild a fresh
// `Candle[]` (Decimal-string → Candle, thousands of rows). Market candles are
// public, not account-scoped, so a process-level cache shared across runs (and
// even profiles) is sound. The engine treats the arrays as read-only inputs, so
// one shared array per key is safe.
//
// Bounded by entry count rather than bytes: distinct keys per window are just
// `symbols × intervals` (×2 if the OOS split shifts the range), so a small bound
// holds the active window in full plus a recent one; a much larger or
// multi-symbol window partially evicts, forfeiting some reuse, never correctness.
// Each entry is a whole window, so the bound is deliberately small.
const DEFAULT_MAX_ENTRIES = 32;

/**
 * Insertion-order LRU over a `Map`: `get` re-inserts to mark recency, `set`
 * evicts the oldest entry once the bound is reached. Single-threaded use only —
 * the candle load is awaited before the engine runs, so concurrent trials in the
 * same worker process never interleave a check-then-set on the same key.
 */
export class LruCandleCache implements CandleCache {
  readonly #map = new Map<string, Candle[]>();
  readonly #max: number;

  constructor(max: number = DEFAULT_MAX_ENTRIES) {
    this.#max = max;
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: string): Candle[] | undefined {
    const value = this.#map.get(key);
    if (value === undefined) return undefined;
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key: string, value: Candle[]): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, value);
  }
}
