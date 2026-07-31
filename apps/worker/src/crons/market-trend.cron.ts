// market-trend cron.
//
// Computes a global read of the broad tape — BTC/ETH daily regime plus USDT
// universe breadth — once per cycle and writes one Redis snapshot the api's
// `/market-trend` route serves to the dashboard. Public market data only (no
// credentials, no profile), so a single snapshot serves every operator view.
//
// Self-rescheduling like technicals-compute: the next run is enqueued on the
// current run's terminal state, so a slow fetch delays rather than overlaps
// the next. Cheap — two daily-kline calls (flat weight 2 each) plus one
// all-tickers call per cycle, all through the shared weight governor.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';

import { MarketTrendSchema } from '@app/contracts';
import { sleep } from '@app/core/sleep';
import { GLOBAL_KEYS } from '@app/db';
import { createBinanceRest, fetchClosedKlines } from '@app/binance';
import type { Candle } from '@app/strategy-core';
import type { BootContext } from 'boot/boot-context.js';

import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import { classifyTrend, computeBreadth, type BreadthTicker } from './market-trend.js';

/** Public Binance REST host — unauthenticated klines. */
const KLINES_BASE_URL = 'https://api.binance.com';
/** Daily candles per proxy symbol. 210 clears the 150-bar slow-EMA warmup. */
const KLINE_LIMIT = 210;
/**
 * Hard ceiling for one cron cycle. The cron self-reschedules on the current
 * run's terminal state, so any unbounded await wedges the chain forever — a
 * stuck cycle never enqueues the next and the snapshot freezes. The fetches
 * already cap network time, but the weight-governor admission wait in front of
 * them does not; this deadline bounds both so a saturated budget aborts the
 * cycle (caught below, reschedules in a minute) instead of stalling for good.
 * Well under `selfReschedulePeriodMs` and longer than a healthy cycle (~2s).
 */
const CYCLE_DEADLINE_MS = 30_000;
/** Proxy symbols whose daily trend stands in for the broad market. */
const PROXY_SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;

export interface MarketTrendDeps {
  readonly logger: Logger;
  /** Closed daily candles for one proxy symbol. `signal` bounds the cycle. */
  readonly fetchDailyCandles: (symbol: string, signal: AbortSignal) => Promise<readonly Candle[]>;
  /** All 24h tickers; breadth filters to the quote universe itself. */
  readonly fetchTickers: (signal: AbortSignal) => Promise<readonly BreadthTicker[]>;
  /** Persist the serialized snapshot to the global market-trend key (no TTL). */
  readonly writeSnapshot: (json: string) => Promise<void>;
  /** Persist the serialized per-symbol price map to the global usd-price-map
   * key (no TTL). Fed the same all-tickers result as breadth. */
  readonly writeUsdPriceMap: (json: string) => Promise<void>;
  readonly clock?: { nowMs(): number };
}

/** Build a symbol→lastPrice map from the 24h tickers, skipping rows with no
 * price or a non-positive one. A halted or never-traded pair reports "0" as its
 * last price; keeping it would render a fake `≈0` value instead of unpriced, so
 * only prices > 0 enter the map (positivity guard on a wire string, matching
 * computeBreadth's Number check — no money math). The projection reads
 * `<asset><quoteAsset>` from this to value held assets. */
const priceMapFrom = (
  tickers: readonly { readonly symbol: string; readonly lastPrice?: string }[],
): Record<string, string> => {
  const prices: Record<string, string> = {};
  for (const t of tickers) {
    if (t.lastPrice === undefined) continue;
    const n = Number(t.lastPrice);
    if (Number.isFinite(n) && n > 0) prices[t.symbol] = t.lastPrice;
  }
  return prices;
};

export const marketTrendHandler =
  (deps: MarketTrendDeps) =>
  async (_job: Job): Promise<void> => {
    const clock = deps.clock ?? { nowMs: () => Date.now() };
    // One deadline for the whole cycle: an abort here rejects the in-flight
    // fetch/reserve, the catch below logs it, and the cron reschedules — the
    // self-reschedule chain can never wedge on a stalled call.
    const deadline = AbortSignal.timeout(CYCLE_DEADLINE_MS);
    try {
      const windows = await Promise.all(
        PROXY_SYMBOLS.map((s) => deps.fetchDailyCandles(s, deadline)),
      );
      const symbols = PROXY_SYMBOLS.map((s, i) => classifyTrend(s, windows[i] ?? [])).filter(
        (x): x is NonNullable<typeof x> => x !== null,
      );
      const tickers = await deps.fetchTickers(deadline);

      // Publish the per-symbol price map first and independently of the trend/
      // breadth classification: the dashboard values held assets from it, so a
      // warming trend widget must not also blank asset valuations. Skip an empty
      // map so a transient empty fetch never clobbers good prices.
      const prices = priceMapFrom(tickers);
      if (Object.keys(prices).length > 0) {
        // Isolated from the snapshot write: a failed price-map set must not
        // suppress the trend snapshot below. Log and continue.
        try {
          await deps.writeUsdPriceMap(JSON.stringify({ computedAtMs: clock.nowMs(), prices }));
        } catch (err) {
          deps.logger.warn({ err: err }, 'market-trend: usd-price-map write failed');
        }
      }

      const breadth = computeBreadth(tickers);

      // No silent failures: a short-data degenerate result is not written, and
      // it is logged so a persistently-warming widget has a worker-side trail.
      if (symbols.length === 0 || breadth === null) {
        deps.logger.warn(
          { symbols: symbols.length, hasBreadth: breadth !== null },
          'market-trend: insufficient data; snapshot not written',
        );
        return;
      }

      const snapshot = MarketTrendSchema.parse({ computedAtMs: clock.nowMs(), symbols, breadth });
      await deps.writeSnapshot(JSON.stringify(snapshot));
      deps.logger.debug(
        { symbols: symbols.length, percentUp: breadth.percentUp },
        'market-trend: snapshot written',
      );
    } catch (err) {
      deps.logger.warn({ err: err }, 'market-trend compute failed (cron continues)');
    }
  };

export const buildMarketTrendCron = (ctx: BootContext): CronDef => {
  // Unsigned public client: getAllTickers24hr needs no credentials. Shares the
  // process weight governor so its calls sit in the same per-IP budget as ticks.
  const rest = createBinanceRest({
    mode: 'live',
    credentials: { apiKey: '', secretKey: '' },
    weightGovernor: ctx.weightGovernor,
  });

  const fetchDailyCandles = (symbol: string, signal: AbortSignal): Promise<readonly Candle[]> =>
    fetchClosedKlines(
      { baseUrl: KLINES_BASE_URL, symbol, interval: '1d', limit: KLINE_LIMIT },
      {
        fetch: globalThis.fetch,
        nowMs: () => Date.now(),
        sleep,
        reserveWeight: (w: number) => ctx.weightGovernor.reserve(w, { signal }),
      },
    );

  return defineCron({
    name: 'market-trend',
    queue: QUEUE_NAMES.marketTrend,
    selfReschedulePeriodMs: 60_000,
    handler: marketTrendHandler({
      logger: ctx.logger,
      fetchDailyCandles,
      fetchTickers: (signal) => rest.getAllTickers24hr(signal),
      // Persist without a TTL: the dashboard must always have a value to show.
      // Each successful cycle overwrites the key, and the snapshot's
      // `computedAtMs` lets the card label staleness ("as of Xm ago") rather
      // than blank to "warming" on a transient gap. A stale-but-labelled read
      // beats a vanished card.
      writeSnapshot: async (json) => {
        await ctx.redis.set(GLOBAL_KEYS.marketTrend(), json);
      },
      // Same no-TTL overwrite-per-cycle policy as the snapshot: the dashboard
      // must always have prices to value held assets, and staleness is bounded
      // by the map's own `computedAtMs`, not by the key expiring.
      writeUsdPriceMap: async (json) => {
        await ctx.redis.set(GLOBAL_KEYS.usdPriceMap(), json);
      },
    }),
  });
};
