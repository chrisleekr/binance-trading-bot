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

// Backtest intervals: the fixed spine (no `1M` — the fill model's fixed grid is
// undefined for a variable-length bar). The zod schema + inferred
// `BacktestInterval` type live in `./backtest.ts` (their home, alongside the
// validator); this owns only the canonical tuple they derive from.
export const BACKTEST_INTERVALS = FIXED_DURATION_INTERVALS;

/** Every interval Binance's kline endpoints accept: `1s` plus the spine plus `1M`. */
export const BINANCE_KLINE_INTERVALS = ['1s', ...FIXED_DURATION_INTERVALS, '1M'] as const;
export type BinanceKlineInterval = (typeof BINANCE_KLINE_INTERVALS)[number];
