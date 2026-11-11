import type { Candle, CandleInterval } from '@app/strategy-core';
import type { MarketDataSource, MarketTick, StreamRequest } from './types.js';

/** A symbol's candle series at one interval, ascending by open time. */
export interface SymbolCandles {
  readonly symbol: string;
  readonly interval: CandleInterval;
  readonly candles: readonly Candle[];
  /**
   * The symbol's finer (timeframe-detail) bars, ascending by open time. When
   * present, each is grouped under the coarse candle whose open-time span
   * contains it and attached to that candle's tick as `detailCandles`, so the
   * fill model crosses orders against the intra-candle path. Omit to stream the
   * coarse interval only.
   */
  readonly detailCandles?: readonly Candle[];
}

/**
 * Group a symbol's detail bars under the coarse candle whose half-open span
 * `[openTimeMs, closeTimeMs]` contains each bar's open time, keyed by coarse
 * open time. Both inputs are ascending, so a single two-pointer pass suffices.
 * Detail bars outside every coarse span (a gap, or before the first candle)
 * are dropped — they belong to no replayed candle.
 */
function groupDetailByCoarse(
  coarse: readonly Candle[],
  detail: readonly Candle[],
): Map<number, Candle[]> {
  const groups = new Map<number, Candle[]>();
  let di = 0;
  for (const c of coarse) {
    // Skip detail bars opening before this coarse candle (pre-window, or a gap).
    while (di < detail.length) {
      const bar = detail[di];
      if (!bar || bar.openTimeMs >= c.openTimeMs) break;
      di++;
    }
    const bucket: Candle[] = [];
    while (di < detail.length) {
      const bar = detail[di];
      if (!bar || bar.openTimeMs > c.closeTimeMs) break;
      bucket.push(bar);
      di++;
    }
    if (bucket.length > 0) groups.set(c.openTimeMs, bucket);
  }
  return groups;
}

/**
 * Lazily merge several per-symbol candle series into one stream ordered by `closeTimeMs` across all symbols, the k-way merge a portfolio run needs so its shared account is mutated in true time order. Lazy because a long one-minute run would otherwise hold every merged tick in memory beside the candles it was built from. Ties break by the input order of the series; the engine re-sorts equal-close frames canonically.
 *
 * Each series is assumed already ascending by open time (the candle store returns them that way). The merge advances a per-series cursor and rescans the cursors for the minimum each step, so it is O(total candles x symbols) with no full sort.
 *
 * @param series - Per-symbol candle series, each ascending by open time.
 * @returns A generator of ticks in close-time order.
 */
export function* iterateCandleTicks(series: readonly SymbolCandles[]): Generator<MarketTick> {
  const cursors = series.map(() => 0);
  // Pre-group each series' detail bars under their coarse candle once, so the merge can attach them in O(1) per emitted tick.
  const detailGroups = series.map((s) =>
    s.detailCandles && s.detailCandles.length > 0
      ? groupDetailByCoarse(s.candles, s.detailCandles)
      : null,
  );

  for (;;) {
    let pick = -1;
    let pickClose = Number.POSITIVE_INFINITY;
    for (let i = 0; i < series.length; i++) {
      const candle = series[i]?.candles[cursors[i] ?? 0];
      if (!candle) continue;
      if (candle.closeTimeMs < pickClose) {
        pickClose = candle.closeTimeMs;
        pick = i;
      }
    }
    if (pick === -1) return; // all series exhausted
    const chosen = series[pick];
    const candle = chosen?.candles[cursors[pick] ?? 0];
    if (!chosen || !candle) return;
    cursors[pick] = (cursors[pick] ?? 0) + 1;
    const detailCandles = detailGroups[pick]?.get(candle.openTimeMs);
    yield {
      kind: 'candle-close',
      symbol: chosen.symbol,
      interval: chosen.interval,
      candle,
      ...(detailCandles ? { detailCandles } : {}),
    };
  }
}

/**
 * In-memory {@link MarketDataSource} over already-loaded per-symbol series,
 * yielding a closeTime-ordered merged stream. The worker builds this from the
 * candle store; tests build it from fixtures. Honors the ordering contract on
 * {@link MarketDataSource}.
 */
export function arrayMarketDataSource(series: readonly SymbolCandles[]): MarketDataSource {
  return {
    stream(_req: StreamRequest): AsyncIterable<MarketTick> {
      async function* gen(): AsyncGenerator<MarketTick> {
        yield* iterateCandleTicks(series);
      }
      return gen();
    },
  };
}
