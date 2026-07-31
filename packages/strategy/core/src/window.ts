/**
 * Candle-window sizing policy shared by the live tick path and the backtest
 * engine, so a config's lookback maps to the SAME window in both worlds. A
 * strategy reports its raw need via {@link Strategy.requiredWindow}; this floors
 * that at the default window (never shrink below what the incremental indicators
 * and the historical baseline expect) and caps it at a hard ceiling that bounds
 * memory and, on the live path, the cold-start REST candle load. A lookback
 * beyond the ceiling is an extreme misconfiguration, not a normal request.
 */

/** Default candle window when a config needs no more — the historical baseline. */
export const DEFAULT_CANDLE_WINDOW = 200;

/** Hard ceiling on the candle window in both paths. Bounds memory and REST load. */
export const MAX_CANDLE_WINDOW = 1_000;

/**
 * Resolve a strategy's raw `requiredWindow` into the candle window both paths
 * load: floored at {@link DEFAULT_CANDLE_WINDOW}, capped at
 * {@link MAX_CANDLE_WINDOW}. `undefined`/non-finite collapses to the default.
 */
export const resolveCandleWindow = (required: number | undefined): number => {
  const r = required ?? 0;
  if (!Number.isFinite(r) || r <= DEFAULT_CANDLE_WINDOW) return DEFAULT_CANDLE_WINDOW;
  return r >= MAX_CANDLE_WINDOW ? MAX_CANDLE_WINDOW : r;
};
