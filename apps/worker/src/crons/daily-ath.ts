// Daily ATH recovery refresher.
//
// `ath:<symbol>` holds the highest high over the trailing window of 200
// *closed* daily candles. The IndicatorComputer writes it on every closed
// 1d candle; if the worker missed a 1d kline-close WS event (crash,
// network blip, or the worker simply was not running at the daily
// close), that key goes stale. The `daily-ath` cron at 00:00 UTC
// re-fetches the same window from Binance's public klines endpoint and
// rewrites the key so the strategy's high-water view recovers without
// waiting for the next live 1d close.
//
// The klines endpoint returns the in-progress day as its last row; that
// row is dropped (the live path only ever folds *closed* candles into the
// window) so the cron computes over the identical 200-closed-candle
// window the live 1d-close path uses.
//
// The cron overwrites unconditionally — by design. It produces the same
// value the live 1d-close path would have written; a `max(existing,
// computed)` guard would make the recovery path diverge from the path it
// backstops once the window's high rolls off.
//
// Pure public endpoint, no signing — runs against BINANCE_HOSTS.live
// because kline history is identical across hosts (mirrors the
// exchange-info-refresh cron's host choice).

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { Candle } from '@app/strategy-core';
import { BINANCE_HOSTS, parseKlines, type ParsedKline } from '@app/binance';
import { ath } from '@app/indicators';
import { athKey } from 'indicator-computer/indicator-computer.js';

const KLINES_PATH = '/api/v3/klines';
const FETCH_TIMEOUT_MS = 15_000;
// Match the IndicatorComputer's window so the recovered value is computed
// over the same horizon as the live 1d-close path.
const WINDOW = 200;
// Fetch one extra row: the most recent kline is the in-progress day, which
// is dropped so `WINDOW` *closed* candles remain.
const FETCH_LIMIT = WINDOW + 1;
// 48h, not the live path's 24h: this cron fires once a day, so a 24h TTL
// would leave zero margin — a single missed midnight run (the exact
// scenario this recovery cron exists for) would expire the key before the
// next write. 48h survives one missed run.
const ATH_TTL_S = 48 * 60 * 60;

export interface DailyAthRefreshDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly host?: string;
  readonly clock?: { nowMs(): number };
}

/**
 * Build the per-symbol ATH refresh closure. The returned function fetches
 * the latest `1d` candle window for one symbol and rewrites `ath:<symbol>`.
 * Throws on an empty / non-OK upstream response so the existing key is
 * left intact rather than overwritten with a value derived from bad data.
 */
export const createDailyAthRefresh = (
  deps: DailyAthRefreshDeps,
): ((symbol: string) => Promise<void>) => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const host = deps.host ?? BINANCE_HOSTS.live;
  const clock = deps.clock ?? { nowMs: () => Date.now() };

  return async (symbol: string) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let rows: ParsedKline[];
    try {
      const url = `${host}${KLINES_PATH}?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=${FETCH_LIMIT}`;
      const res = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`daily-ath: upstream ${res.status} ${res.statusText} for ${symbol}`);
      }
      // Validate at the boundary: parseKlines throws KlineParseError on a
      // drifted wire layout rather than letting a mis-mapped column become a
      // wrong ATH. The error propagates (fanOut collects it; a total failure
      // retries the job) — the existing key is left intact, never overwritten
      // from bad data.
      rows = parseKlines(await res.json());
    } finally {
      clearTimeout(timer);
    }
    if (rows.length === 0) {
      // Refuse to overwrite a good `ath:<symbol>` with a value derived
      // from an empty payload — leave the existing key.
      throw new Error(`daily-ath: upstream returned 0 klines for ${symbol}`);
    }
    const now = clock.nowMs();
    // Keep only closed candles (drops the in-progress day) and cap to the
    // window — matching the live 1d-close path's 200-closed-candle window.
    const window: Candle[] = rows
      .map((k) => ({
        openTimeMs: k.openTimeMs,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
        closeTimeMs: k.closeTimeMs,
        isClosed: k.closeTimeMs <= now,
      }))
      .filter((c) => c.isClosed)
      .slice(-WINDOW);
    if (window.length === 0) {
      throw new Error(`daily-ath: no closed klines for ${symbol}`);
    }
    const value = ath(window).toFixed();
    await deps.redis.set(athKey(symbol), value, 'EX', ATH_TTL_S);
    deps.logger.info({ symbol, ath: value, candles: window.length }, 'daily-ath: refreshed');
  };
};
