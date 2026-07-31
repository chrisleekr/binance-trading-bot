import type { Logger } from 'pino';
import type { BinanceRestClient, ParsedKline } from '@app/binance';
import { intervalToMs, schema, type MsRange } from '@app/db';

// Binance returns at most 1000 candles per klines call; weight is 2 at
// limit <= 500, 5 above. We page at 500 to stay on the cheap weight tier —
// the same ceiling the technicals cron observes.
const PAGE_LIMIT = 500;

export interface CandleBackfillDeps {
  /**
   * Typed klines fetch — usually a governor-wired `BinanceRestClient.getKlines`,
   * so the per-IP weight is reserved inside the client (no double-reserve here).
   * Tests inject a stub.
   */
  readonly getKlines: BinanceRestClient['getKlines'];
  /** Missing open-time ranges for a (symbol, interval); usually `repo.candles.findGaps`. */
  readonly findGaps: (
    symbol: string,
    interval: string,
    fromMs: number,
    toMs: number,
  ) => Promise<MsRange[]>;
  /** Idempotent insert (insert-or-ignore); usually `repo.candles.insertNew`. */
  readonly insertCandles: (rows: readonly schema.CandleInsert[]) => Promise<void>;
  readonly clock: { nowMs(): number };
  readonly logger?: Logger;
}

export interface BackfillResult {
  /** Candles inserted (excludes duplicates the store ignored and the forming bar). */
  readonly inserted: number;
  /** Binance klines requests issued. */
  readonly requests: number;
}

/**
 * Ensures the candle store covers `[fromMs, toMs]` for one (symbol, interval),
 * fetching only the gaps. Idempotent: a fully-covered range issues zero
 * requests because `findGaps` returns nothing. Stores candles under the
 * caller's `symbol` (which may carry an `EXCHANGE:` prefix); only the Binance
 * REST call uses the bare symbol. The currently-forming bar is never stored —
 * a backtest acts on closed candles only — so a range whose tail is still open
 * stays a gap until those candles close.
 */
export async function backfillCandles(
  deps: CandleBackfillDeps,
  params: { symbol: string; interval: string; fromMs: number; toMs: number },
): Promise<BackfillResult> {
  const { symbol, interval, fromMs, toMs } = params;
  const intervalMs = intervalToMs(interval);
  const bare = symbol.includes(':') ? (symbol.split(':')[1] ?? symbol) : symbol;

  const gaps = await deps.findGaps(symbol, interval, fromMs, toMs);
  let inserted = 0;
  let requests = 0;

  for (const gap of gaps) {
    let cursor = gap.fromMs;
    while (cursor <= gap.toMs) {
      const rows = await deps.getKlines({
        symbol: bare,
        interval,
        startTime: cursor,
        endTime: gap.toMs,
        limit: PAGE_LIMIT,
      });
      requests += 1;
      if (rows.length === 0) break;

      const { inserts, lastOpenTime } = mapRows(
        rows,
        symbol,
        interval,
        gap.toMs,
        deps.clock.nowMs(),
      );
      if (inserts.length > 0) {
        await deps.insertCandles(inserts);
        inserted += inserts.length;
      }

      // Advance past the last candle this page returned. A page that did not
      // move the cursor forward (e.g. a single sub-cursor row) would loop
      // forever, so break instead.
      const next = lastOpenTime + intervalMs;
      if (next <= cursor) break;
      cursor = next;

      // Do NOT stop on a short page. Binance returns fewer than a full page for
      // windows with missing minutes (illiquid symbols) or transient clipping,
      // yet more candles exist later in the gap. Stopping early left mid-gap
      // holes that later runs accreted from the shared candle table, so the same
      // backtest config drifted run-to-run. The loop ends only on the gap bound
      // (while), an empty page (end of data), or a non-advancing cursor.
      //
      // Termination is finite: each kept page either raises cursor by at least
      // intervalMs (the server returns openTime >= startTime) or trips the
      // `next <= cursor` break above; combined with the `cursor <= gap.toMs`
      // bound, iterations cannot exceed the gap's candle count.
    }
  }

  deps.logger?.info({ symbol, interval, gaps: gaps.length, inserted, requests }, 'candle backfill');
  return { inserted, requests };
}

/**
 * Decode a klines page into insert rows, dropping the forming bar
 * (`closeTime >= nowMs`) and anything past the requested window. Returns the
 * greatest open-time seen (including dropped rows) so the caller can advance
 * its cursor even when every row in the page was filtered out.
 */
function mapRows(
  rows: readonly ParsedKline[],
  symbol: string,
  interval: string,
  windowEndMs: number,
  nowMs: number,
): { inserts: schema.CandleInsert[]; lastOpenTime: number } {
  const inserts: schema.CandleInsert[] = [];
  // 0 is a safe "nothing seen" sentinel: the caller only invokes mapRows with
  // a non-empty page, and a conformant server returns openTime >= startTime > 0.
  let lastOpenTime = 0;
  for (const k of rows) {
    if (k.openTimeMs > lastOpenTime) lastOpenTime = k.openTimeMs;
    if (k.closeTimeMs >= nowMs) continue; // forming bar
    if (k.openTimeMs > windowEndMs) continue; // past the requested window
    inserts.push({
      symbol,
      interval,
      openTime: new Date(k.openTimeMs),
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
      closeTime: new Date(k.closeTimeMs),
    });
  }
  return { inserts, lastOpenTime };
}
