import { Decimal } from '@app/money';
import type { Candle } from '@app/strategy-core';
import { safeDecimal } from './safe-decimal.js';

/**
 * Chase-guard veto detail: the 24h high, the current price, and the configured
 * max distance, all decimal-strings (the strategy boundary forbids `number` for
 * money). Surfaced as the entry-blocker detail so the operator gloss can explain
 * why a discovery entry was held back.
 */
export interface ChaseGuardVeto {
  readonly high24h: string;
  readonly currentPrice: string;
  readonly distancePct: string;
}

/**
 * Knife-guard veto detail: the measured top-to-last-close decline (percent) over
 * the window and the candle count examined. Decimal-strings for the same reason.
 */
export interface KnifeGuardVeto {
  readonly dropPct: string;
  readonly candles: number;
}

/**
 * Anti-chase guard: refuse a discovery entry while price is within
 * `maxDistancePct` percent of the 24h high, so the bot does not buy a coin that
 * already ran. Returns null (no veto) when the guard is off or its inputs are
 * absent/unparseable; else the veto detail. Off when `high24h` is absent or
 * `maxDistancePct` is undefined / '0' / 0 (the disabled sentinels).
 *
 * Veto when currentPrice >= high24h * (1 - pct/100): at the boundary distance
 * the price is exactly that far below the high, and anything closer (higher) is
 * inside the chase band.
 *
 * `high24h` is the add-time snapshot threaded via the entry-hint bundle, so it
 * is intentionally stale across a multi-tick deferral; the enterOnAdd entry is
 * moments after add, so it captures the pump top the operator picked into.
 */
export const chaseGuard = (
  currentPrice: string,
  high24h: string | undefined,
  maxDistancePct: string | undefined,
): ChaseGuardVeto | null => {
  if (high24h === undefined || maxDistancePct === undefined) return null;
  const pct = safeDecimal(maxDistancePct);
  if (pct === null || !pct.gt(0)) return null;
  const high = safeDecimal(high24h);
  const price = safeDecimal(currentPrice);
  if (high === null || price === null || !high.gt(0)) return null;
  // threshold = high * (1 - pct/100); a price at or above it is chasing the run.
  const threshold = high.mul(new Decimal(1).minus(pct.div(100)));
  if (price.gte(threshold)) {
    return { high24h, currentPrice, distancePct: maxDistancePct };
  }
  return null;
};

/**
 * Falling-knife guard: refuse a discovery entry while the last `knifeCandles`
 * closed candles have declined by at least `knifeDropPercent` percent. The
 * decline reference is the HIGHEST close in the window (top-to-last-close), so a
 * window that opens with a green push then sells off is measured from its peak,
 * not its first bar. Returns null (no veto) when the guard is off or there are
 * not enough closed candles; else the veto detail. Off when `knifeCandles` is
 * falsy / < 1 or `knifeDropPercent` is undefined / '0' / 0.
 *
 * Pure: `Math` is banned in strategy code, so the window slice, the max-close
 * fold, and the percent compare are all hand-rolled on Decimal.
 */
export const knifeGuard = (
  closedCandles: readonly Candle[] | undefined,
  knifeCandles: number | undefined,
  knifeDropPercent: string | undefined,
): KnifeGuardVeto | null => {
  if (knifeCandles === undefined || knifeCandles < 1 || knifeDropPercent === undefined) return null;
  const dropPct = safeDecimal(knifeDropPercent);
  if (dropPct === null || !dropPct.gt(0)) return null;
  if (closedCandles === undefined || closedCandles.length < knifeCandles) return null;

  const window = closedCandles.slice(closedCandles.length - knifeCandles);
  // `at(-1)` is defined because the length >= knifeCandles >= 1 check above holds;
  // a null parse (unparseable last close) abstains.
  const last = window.at(-1) as Candle;
  const lastClose = safeDecimal(last.close);
  if (lastClose === null) return null;

  // Reference = the highest close in the window (the local top the price fell
  // from). A null close (unparseable) is skipped; if every close is unparseable
  // or non-positive the reference is unusable and the guard abstains (a zero
  // reference would divide by zero below).
  let maxClose: ReturnType<typeof safeDecimal> = null;
  for (const c of window) {
    const close = safeDecimal(c.close);
    if (close === null || !close.gt(0)) continue;
    if (maxClose === null || close.gt(maxClose)) maxClose = close;
  }
  if (maxClose === null) return null;

  // decline = (maxClose - lastClose) / maxClose * 100. A flat-or-up window yields
  // <= 0, which never meets a positive dropPct, so the guard only bites a real
  // top-to-last decline.
  const declinePct = maxClose.minus(lastClose).div(maxClose).mul(100);
  if (declinePct.gte(dropPct)) {
    return { dropPct: declinePct.toString(), candles: knifeCandles };
  }
  return null;
};
