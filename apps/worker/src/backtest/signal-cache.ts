import type { TechnicalsSignal } from '@app/contracts';

/**
 * Minimal read/write surface a backtest run needs from a signal cache. `Map` satisfies it structurally; the bounded cache below implements the same surface.
 */
export interface SignalCache {
  get(key: string): TechnicalsSignal | undefined;
  set(key: string, value: TechnicalsSignal): void;
}

// The technicals signal (minus its read-time `receivedAtMs`) is a pure function of the candle window, so a run derives each distinct window once. The derive is the dominant per-decision cost (about 30 rating indicators plus a Zod parse). Each run owns its cache, so no run can read another run's derived values. The caller re-stamps `receivedAtMs` on read so freshness still tracks the decision. The bound fits a 12-month single-symbol run over a few technicals intervals (about 11k keys); longer windows evict, which forfeits reuse and never correctness. A parsed signal is about 33 numbers, so the cap is a few MB.
const DEFAULT_MAX_ENTRIES = 15_000;

/**
 * Insertion-order LRU over a `Map`: `get` re-inserts to mark recency, `set`
 * evicts the oldest entry once the bound is reached. Single-threaded use only,
 * since the backtest signal compute is synchronous, so concurrent trials in the
 * same worker process never interleave a check-then-set.
 */
export class LruSignalCache implements SignalCache {
  readonly #map = new Map<string, TechnicalsSignal>();
  readonly #max: number;

  constructor(max: number = DEFAULT_MAX_ENTRIES) {
    this.#max = max;
  }

  get size(): number {
    return this.#map.size;
  }

  get(key: string): TechnicalsSignal | undefined {
    const value = this.#map.get(key);
    if (value === undefined) return undefined;
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  set(key: string, value: TechnicalsSignal): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
    } else if (this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, value);
  }
}
