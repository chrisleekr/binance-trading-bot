// Pure helpers for the candle store: kline-interval → milliseconds, and
// gap detection over a candle open-time grid. They live outside `repo/` so
// they are not subject to the repo scope-parameter AST check (they take
// neither a Database nor a ProfileScope). Shared by the candle repo
// (findGaps) and the worker candle backfill.

/**
 * Fixed-duration Binance kline intervals in milliseconds. `1M` (calendar
 * month) is intentionally absent — its duration is not constant, so a
 * fixed-grid gap walk is undefined for it; callers must reject it upstream.
 */
const INTERVAL_MS: Readonly<Record<string, number>> = Object.freeze({
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
});

/**
 * Milliseconds spanned by one candle of `interval`. Throws on an unknown or
 * non-fixed-duration interval (e.g. `1M`) rather than guessing — a wrong
 * cadence would silently corrupt gap detection and the backfill loop.
 */
export function intervalToMs(interval: string): number {
  const ms = INTERVAL_MS[interval];
  if (ms === undefined) {
    throw new Error(`unsupported candle interval: ${interval}`);
  }
  return ms;
}

export interface MsRange {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Given the open-times already present for a (symbol, interval) and a
 * requested `[fromMs, toMs]` window, returns the contiguous sub-ranges whose
 * candles are missing — each as `{ fromMs, toMs }` aligned to interval
 * boundaries, suitable for handing to a backfill fetch loop.
 *
 * The grid is anchored at the first interval boundary >= fromMs and walked
 * by `intervalMs` up to and including the last boundary <= toMs. Present
 * open-times are matched against that grid; runs of absent boundaries
 * collapse into one range. `toMs` of each returned range is the open-time of
 * the last missing candle in the run (not its close-time), matching how
 * Binance `startTime`/`endTime` select candles by open-time.
 *
 * Returns an empty array when the window is empty or fully populated.
 */
export function computeMissingRanges(
  presentOpenTimesMs: readonly number[],
  fromMs: number,
  toMs: number,
  intervalMs: number,
): MsRange[] {
  if (intervalMs <= 0) throw new Error('intervalMs must be positive');
  if (toMs < fromMs) return [];

  // Align the first boundary to the interval grid. Binance candle open-times
  // are multiples of the interval from the epoch, so a request whose fromMs
  // falls mid-candle must round up to the next boundary.
  const firstBoundary = Math.ceil(fromMs / intervalMs) * intervalMs;
  if (firstBoundary > toMs) return [];

  const present = new Set(presentOpenTimesMs);
  const ranges: MsRange[] = [];
  let runStart: number | null = null;
  let prevMissing = 0;

  for (let t = firstBoundary; t <= toMs; t += intervalMs) {
    if (present.has(t)) {
      if (runStart !== null) {
        ranges.push({ fromMs: runStart, toMs: prevMissing });
        runStart = null;
      }
    } else {
      if (runStart === null) runStart = t;
      prevMissing = t;
    }
  }
  if (runStart !== null) ranges.push({ fromMs: runStart, toMs: prevMissing });
  return ranges;
}
