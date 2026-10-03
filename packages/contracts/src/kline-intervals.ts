// Single source for the kline-interval tuples, keyed on the fixed-duration
// spine so every derivation is an additive `as const` spread. `.filter()` is
// never used: it widens `readonly [...]` to `string[]`, which breaks both the
// literal-union types below and `z.enum` (which needs `[string, ...string[]]`).
//
// This lives in @app/contracts (the leaf) so strategy-core and apps/api derive
// from it without a cycle — contracts depends only on decimal.js + zod.

/**
 * Fixed-duration candle intervals, finest→coarsest. Order is load-bearing:
 * rank comparisons index into it (`intervalRank`'s `.indexOf`). Excludes `1M`
 * (calendar month) — its duration is not constant.
 */
const FIXED_DURATION_INTERVALS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
] as const;

/** The closed kline-interval set a strategy operates on: fixed spine plus `1M`. */
export const CANDLE_INTERVALS = [...FIXED_DURATION_INTERVALS, '1M'] as const;
export type CandleInterval = (typeof CANDLE_INTERVALS)[number];

/** True iff `v` is one of the closed {@link CANDLE_INTERVALS}. Narrows for wire decode. */
export const isCandleInterval = (v: unknown): v is CandleInterval =>
  typeof v === 'string' && (CANDLE_INTERVALS as readonly string[]).includes(v);

/**
 * Milliseconds spanned by one candle, for the fixed-duration spine only. `1M` is absent because a calendar month has no constant length, so anything that divides by this table would be wrong for it by up to three days.
 *
 * Lives here, beside the tuple it is keyed on, for the reason the file header gives: a second copy of this table somewhere else drifts the moment an interval is added, and nothing type-checks the two against each other.
 *
 * A `Map` and not an object literal, matching the sibling interval mapper in `@app/binance`. A bracket lookup on an object walks the prototype chain and `Object.freeze` does not change that, so `'constructor'`, `'toString'` and `'__proto__'` would each resolve to something non-nullish, defeat the `?? null` below, and hand a caller a function where its type promises a number — which then divides to `NaN` and reads as a mapped interval. A `Map` has no such fallback for its keys.
 */
const FIXED_INTERVAL_MS: ReadonlyMap<string, number> = new Map(
  Object.entries({
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '6h': 21_600_000,
    '8h': 28_800_000,
    '12h': 43_200_000,
    '1d': 86_400_000,
    '3d': 259_200_000,
    '1w': 604_800_000,
  }),
);

/**
 * Milliseconds in one candle of `interval`, or null when the interval is unknown or has no constant length (`1M`).
 *
 * Null rather than a throw so a PURE caller that merely wants to reason about cadence can degrade to "not known" instead of taking down whatever it is embedded in. A caller that genuinely cannot proceed without the number keeps its own throwing wrapper, which is what `@app/db`'s `intervalToMs` is.
 *
 * @param interval - A candle interval string, from config or the wire; not assumed valid, and not assumed to be an OWN key of anything.
 * @returns The candle's duration in ms, or null when it is unknown or variable-length.
 */
export const candleIntervalMs = (interval: string): number | null =>
  FIXED_INTERVAL_MS.get(interval) ?? null;

// Backtest intervals: the fixed spine (no `1M` — the fill model's fixed grid is
// undefined for a variable-length bar). The zod schema + inferred
// `BacktestInterval` type live in `./backtest.ts` (their home, alongside the
// validator); this owns only the canonical tuple they derive from.
export const BACKTEST_INTERVALS = FIXED_DURATION_INTERVALS;

/** Every interval Binance's kline endpoints accept: `1s` plus the spine plus `1M`. */
export const BINANCE_KLINE_INTERVALS = ['1s', ...FIXED_DURATION_INTERVALS, '1M'] as const;
export type BinanceKlineInterval = (typeof BINANCE_KLINE_INTERVALS)[number];
