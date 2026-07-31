/**
 * Trend-filter config coercion, shared by the tick gate and the required-window
 * calc. Now that `trendFilter` is per-symbol overridable, a partial override
 * (e.g. `{ enabled: true }`) merged onto a profile with no trend-filter block
 * reaches the tick with `period`/`maType` undefined — the live worker reads
 * config unparsed. Coerce here so the indicators never see an undefined period.
 */

/** Trend-line lookback as a finite int >= 2, else the 200 default. */
export const trendPeriod = (raw: unknown): number => {
  const n = Number.parseInt(String(raw ?? 200), 10);
  return Number.isFinite(n) && n >= 2 ? n : 200;
};

/** Moving-average type; anything but 'ema' reads as 'sma'. */
export const trendMaType = (raw: unknown): 'sma' | 'ema' => (raw === 'ema' ? 'ema' : 'sma');
