import type { TechnicalsSignal } from '@app/contracts';

/**
 * Minimal read/write surface a backtest run needs from a signal cache. `Map`
 * satisfies it structurally, so a single run can still pass a plain `Map` for
 * per-run memoisation; the shared process-level cache below implements the same
 * surface with a bound.
 */
export interface SignalCache {
  get(key: string): TechnicalsSignal | undefined;
  set(key: string, value: TechnicalsSignal): void;
}

// The technicals signal (minus its read-time `receivedAtMs`) is a pure function
// of the candle window (symbol, interval, the closes feeding it), never of the
// strategy config or profile. Separate backtest runs over the SAME candles with
// only the config varying otherwise each derive an identical signal series. A
// process-level cache (market candles are public, not account-scoped) collapses
// that to one compute per (symbol, interval, window) for the process: the
// dominant per-tick cost (~30 rating indicators, the ema5/sma5 courtesy replays,
// and the ~33-field Zod parse), gone for later runs and for every same-window
// tick within a run. The caller re-stamps `receivedAtMs` on read so freshness
// still tracks the tick. The bound sizes for the guided wizard's domain (a
// 12-month single-symbol run over a few technicals intervals is ~11k distinct
// keys); much longer or multi-symbol windows partially evict, which only
// forfeits some reuse, never correctness. A
// post-Zod signal is a small flat object of ~33 numbers, so the cap is a few MB.
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
