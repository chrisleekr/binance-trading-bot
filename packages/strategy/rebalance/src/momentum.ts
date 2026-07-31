import { Decimal } from '@app/money';

/** Candle window element the momentum score reads — just the close price. */
interface CloseCandle {
  readonly close: string;
}

/**
 * Trailing return over `lookbackCandles`: last close ÷ close N candles ago − 1.
 * Returns `null` when the window is too short to span the lookback (so the symbol
 * is excluded from the ranking rather than ranked on a guess) or a close is
 * non-positive / unparseable (a bad candle). Pure Decimal math.
 */
export const momentumScore = (
  window: readonly CloseCandle[],
  lookbackCandles: number,
): Decimal | null => {
  if (window.length <= lookbackCandles) return null;
  const last = window[window.length - 1];
  const past = window[window.length - 1 - lookbackCandles];
  /* v8 ignore start -- length > lookbackCandles guarantees both indices are in range; the guard only satisfies noUncheckedIndexedAccess. */
  if (last === undefined || past === undefined) return null;
  /* v8 ignore stop */
  let lastClose: Decimal;
  let pastClose: Decimal;
  try {
    lastClose = new Decimal(last.close);
    pastClose = new Decimal(past.close);
  } catch {
    return null;
  }
  if (pastClose.lte(0) || lastClose.lte(0)) return null;
  return lastClose.div(pastClose).sub(1);
};

/** One ranked candidate: a symbol and its trailing-return score (higher = stronger). */
export interface MomentumEntry {
  readonly symbol: string;
  readonly score: Decimal;
}

/**
 * Equal-weight target for `self` under top-K cross-sectional momentum. Ranks self
 * plus its scored siblings by score descending, breaking ties by symbol ascending
 * so every symbol's tick computes the identical order from the same KV snapshot.
 * If self lands in the top `min(topK, count)` it gets `1 / that-count` (so the
 * held weights always sum to 1), otherwise 0 — which rotates it to cash. Siblings
 * with too little history are excluded by the caller before this runs.
 */
export const momentumTargetWeight = (
  self: MomentumEntry,
  siblings: readonly MomentumEntry[],
  topK: number,
): Decimal => {
  // Codepoint compare for the tie-break, never String.localeCompare: the latter
  // is ICU/locale-dependent, so two runtimes could break a score tie differently
  // and hold a different basket — the same reproducibility rule the backtest
  // engine enforces. Ranked symbols are unique (KV keys are), so a strict `<`
  // suffices; there is no equal-symbol case to return 0 for.
  const ranked = [self, ...siblings].sort(
    (a, b) => b.score.cmp(a.score) || (a.symbol < b.symbol ? -1 : 1),
  );
  // min(topK, count) without the Math global (banned in pure strategy code).
  const held = topK < ranked.length ? topK : ranked.length;
  const rank = ranked.findIndex((e) => e.symbol === self.symbol);
  if (rank >= held) return new Decimal(0);
  return new Decimal(1).div(held);
};
