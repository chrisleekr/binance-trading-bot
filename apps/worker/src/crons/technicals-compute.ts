// In-process Technical Ratings computation. Fetches public Binance klines
// for each (symbol, interval) pair and runs `computeTechnicalsRating` from
// `@app/indicators/rating`, writes one Redis key per symbol on a single
// pipeline plus one per-interval status receipt. The external scanner this
// cron used to POST to was permanently CloudFront-WAF-blocked from our IP;
// the math now runs locally on top of MIT-vendored indicator code (see
// `packages/indicators/src/rating/vendored/ATTRIBUTION.md`).

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import { TechnicalsFetchStatusSchema, type TechnicalsFetchStatus } from '@app/contracts';
import { fanOutBounded } from '@app/core/fan-out';
import { GLOBAL_KEYS, intervalToMs } from '@app/db';
import { computeTechnicalsRating } from '@app/indicators/rating';
import type { Candle } from '@app/strategy-core';
import { fetchClosedKlines, type WeightGovernor } from '@app/binance';

import { commitPipelineChecked } from 'lib/redis-pipeline.js';
import { ratingToSignal } from 'technicals/rating-to-signal.js';

/**
 * Soft TTL on the per-interval fetch-status Redis key. A missing key signals
 * "cron has not run for a while" to the operator dashboard; the cron writes
 * on every commit so the key refreshes on healthy ticks.
 */
const FETCH_STATUS_TTL_SECONDS = 300;

/** Public Binance REST host — unauthenticated klines. The fetcher in
 * @app/binance reserves the flat klines weight (2). */
const KLINES_BASE_URL = 'https://api.binance.com';

/** Number of candles we feed each indicator. 250 covers EMA200's warmup. */
const KLINE_LIMIT = 250;

/**
 * How many Binance fetches we let run concurrently per interval. At weight 2
 * per call (klines is a flat weight 2) this sits comfortably under the per-IP
 * spot REQUEST_WEIGHT ceiling the executor's throttle enforces
 * (`DEFAULT_BINANCE_WEIGHT_LIMIT_1M` in `apps/worker/src/profile-bindings`).
 */
const KLINE_CONCURRENCY = 8;

export interface CreateFetchAndCacheDeps {
  /** Raw ioredis client. Pipelined writes commit through it. */
  readonly redis: Redis;
  /** Per-key TTL applied to every successful write. */
  readonly signalTtlSeconds: number;
  /** Wall-clock source. Tests inject a fixed clock for deterministic `receivedAtMs`. */
  readonly clock?: { nowMs(): number };
  /** Pino logger. One info-level line per call describes the outcome. */
  readonly logger: Logger;
  /**
   * Injected fetch — tests stub this with an in-process klines server. Defaults
   * to `globalThis.fetch`. Upper bound on the call is the BullMQ job timeout.
   */
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Source of historical OHLCV candles for a (symbol, interval). Defaults to
   * a public Binance REST call via `deps.fetch`. Tests pass a fixture loader.
   */
  readonly fetchKlines?: (symbol: string, interval: string) => Promise<readonly Candle[]>;
  /**
   * Optional shared rate-limit governor. When supplied, each kline fetch
   * reserves the documented Binance weight (`GET /api/v3/klines` = 2 at
   * `limit <= 500`) before issuing the request. Lets tick + cron + cold-
   * load share one per-IP budget instead of independently 429-ing.
   */
  readonly weightGovernor?: WeightGovernor;
  /**
   * Max concurrent kline fetches (and their subsequent synchronous rating
   * computes) per interval. Defaults to {@link KLINE_CONCURRENCY}. Threaded from
   * env so it is tunable without a rebuild on a shared-core box.
   */
  readonly klineConcurrency?: number;
}

// The rating→signal mapping (bucketize + the TechnicalsSignal projection) is
// single-sourced in technicals/rating-to-signal.ts so the live cron and the
// backtest runner cannot drift. Re-exported here for the existing tests.
export { bucketize } from 'technicals/rating-to-signal.js';
import { errorMessage } from '@app/core/error';
import { sleep } from '@app/core/sleep';

/**
 * Overwrite a cached signal's `receivedAtMs` with `nowMs`. The freshness gate
 * reads `signal.receivedAtMs`; a healthy candle-not-closed skip has confirmed
 * the rating is still the current candle's, so age must mean "time since we
 * confirmed this is current", not "time since we recomputed". Without this a
 * 1h rating (recomputed hourly) reads stale for ~55 of every 60 minutes.
 * Malformed JSON (we wrote it, so this should never happen) is re-stored
 * unchanged so the TTL still refreshes.
 */
const restampReceivedAt = (raw: string, nowMs: number): string => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed['receivedAtMs'] = nowMs;
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
};

/**
 * Default klines source: the shared strict fetcher in @app/binance (decode,
 * open-bar drop, retry-with-Retry-After, flat weight reservation). Symbols
 * arrive as `BINANCE:BTCUSDT`; the REST endpoint wants the bare `BTCUSDT`.
 * Request one extra row because the latest bar is still forming — the fetcher
 * drops it via `closeTimeMs < now`.
 */
const defaultFetchKlines =
  (
    fetchImpl: typeof globalThis.fetch,
    clock: { nowMs(): number },
    governor: WeightGovernor | undefined,
  ) =>
  (symbol: string, interval: string): Promise<readonly Candle[]> => {
    const bare = symbol.includes(':') ? (symbol.split(':')[1] ?? symbol) : symbol;
    return fetchClosedKlines(
      { baseUrl: KLINES_BASE_URL, symbol: bare, interval, limit: KLINE_LIMIT + 1 },
      {
        fetch: fetchImpl,
        nowMs: () => clock.nowMs(),
        sleep,
        // Reserve only when a governor is configured; the optional dep is
        // omitted (not set to undefined) under exactOptionalPropertyTypes.
        ...(governor ? { reserveWeight: (w: number) => governor.reserve(w) } : {}),
      },
    );
  };

/**
 * Build the `fetchAndCache` function the cron registry expects. The returned
 * function takes (interval, symbols), fans out klines fetches with a
 * concurrency cap, computes a rating per symbol, and pipelines one SET per
 * successful row plus one status receipt for the interval. Per-symbol fetch
 * failures degrade to a counter bump and an `error` summary on the receipt
 * — other symbols still cache their signals.
 */
export const createFetchAndCache = (
  deps: CreateFetchAndCacheDeps,
): ((interval: string, symbols: readonly string[]) => Promise<void>) => {
  const clock = deps.clock ?? { nowMs: () => Date.now() };
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const fetchKlines = deps.fetchKlines ?? defaultFetchKlines(fetchImpl, clock, deps.weightGovernor);
  const klineConcurrency = deps.klineConcurrency ?? KLINE_CONCURRENCY;

  return async (interval, symbols) => {
    const startMs = clock.nowMs();
    // Read prior receipt to preserve `lastFreshAtMs` across failed writes
    // and detect a fail→success transition for the recovered log event.
    let priorLastFreshAtMs: number | null = null;
    let priorLastComputedCloseMs: number | null = null;
    let priorHadError = false;
    try {
      const priorRaw = await deps.redis.get(GLOBAL_KEYS.technicalsComputeStatus(interval));
      if (priorRaw !== null) {
        const parsed = TechnicalsFetchStatusSchema.safeParse(JSON.parse(priorRaw));
        if (parsed.success) {
          priorLastFreshAtMs = parsed.data.lastFreshAtMs;
          priorLastComputedCloseMs = parsed.data.lastComputedCloseMs;
          priorHadError = parsed.data.error !== null;
        }
      }
    } catch {
      // Benign: missing/malformed prior receipt → start fresh.
    }

    const writeStatus = async (status: TechnicalsFetchStatus): Promise<void> => {
      try {
        await deps.redis.set(
          GLOBAL_KEYS.technicalsComputeStatus(interval),
          JSON.stringify(status),
          'EX',
          FETCH_STATUS_TTL_SECONDS,
        );
      } catch (err) {
        deps.logger.warn(
          { interval, err: err },
          'technicals fetch-status write failed (cron continues)',
        );
      }
    };

    // Candle-close gate: a Technical Rating can only change when a candle
    // closes, so skip the upstream fetch while the current closed-candle
    // boundary matches what we last computed. Binance candles align to epoch,
    // so one boundary serves every symbol on this interval. An unknown
    // interval (intervalToMs throws) disables gating — always fetch.
    let intervalMs: number | null = null;
    try {
      intervalMs = intervalToMs(interval);
    } catch {
      intervalMs = null;
    }
    const closedBoundaryMs =
      intervalMs !== null ? Math.floor(startMs / intervalMs) * intervalMs : null;
    const candleClosed =
      closedBoundaryMs === null ||
      priorLastComputedCloseMs === null ||
      closedBoundaryMs > priorLastComputedCloseMs;

    if (!candleClosed && symbols.length > 0) {
      // No new candle since the last compute. Refresh the cached signals' TTL
      // and the receipt without a Binance fetch — but only when every requested
      // symbol already has a cached signal. A missing one (e.g. a newly added
      // symbol) falls through to a real fetch so it is not starved until the
      // next close.
      const keys = symbols.map((s) => GLOBAL_KEYS.technicals(s, interval));
      let cached: (string | null)[] = [];
      try {
        cached = await deps.redis.mget(keys);
      } catch {
        cached = [];
      }
      const allPresent = cached.length === symbols.length && cached.every((v) => v !== null);
      if (allPresent) {
        // One skip timestamp feeds both the re-stamped signal `receivedAtMs`
        // (read by the gate) and the receipt `lastFreshAtMs` (read by the
        // dashboard). When the refresh commit fails the signals are NOT
        // re-stamped, so the receipt holds `lastFreshAtMs` at the prior value
        // and records the error — the two freshness notions still cannot
        // diverge, and the failure is not masked (invariant #2).
        const skippedAtMs = clock.nowMs();
        const refresh = deps.redis.pipeline();
        cached.forEach((value, i) => {
          refresh.set(
            keys[i] as string,
            restampReceivedAt(value as string, skippedAtMs),
            'EX',
            deps.signalTtlSeconds,
          );
        });
        let refreshError: string | null = null;
        try {
          await commitPipelineChecked(refresh, 'signal-TTL refresh');
        } catch (err) {
          refreshError = errorMessage(err) || 'signal-TTL refresh failed';
          deps.logger.warn(
            { interval, err },
            'technicals signal-TTL refresh failed (cron continues)',
          );
        }
        const refreshOk = refreshError === null;
        await writeStatus(
          TechnicalsFetchStatusSchema.parse({
            interval,
            fetchedAtMs: skippedAtMs,
            requested: symbols.length,
            written: 0,
            skippedErrored: 0,
            skippedInvalid: 0,
            latencyMs: skippedAtMs - startMs,
            // On a healthy refresh the cached signals are confirmed-fresh as of
            // now (no newer candle exists), so the "last updated" readout keeps
            // ticking — only the upstream fetch is skipped. A failed refresh did
            // not re-stamp the signals, so hold the prior value and surface it.
            lastFreshAtMs: refreshOk ? skippedAtMs : priorLastFreshAtMs,
            lastComputedCloseMs: priorLastComputedCloseMs,
            error: refreshOk ? null : `signal-refresh: ${refreshError}`,
          }),
        );
        deps.logger.debug(
          { interval, requested: symbols.length, closedBoundaryMs },
          'technicals computeAndCache: skipped (no candle close)',
        );
        // A recovery can land on a skip iteration (a prior failure left signals
        // cached on the same boundary). Only a healthy refresh clears the error
        // state, so emit the recovered signal the fetch path does — otherwise
        // the fail→recovery transition is silently swallowed (invariant #2).
        if (refreshOk && priorHadError && priorLastFreshAtMs !== null) {
          deps.logger.info(
            { interval, downtimeMs: skippedAtMs - priorLastFreshAtMs, lastFreshAtMs: skippedAtMs },
            'technicals compute-recovered',
          );
        }
        return;
      }
    }

    // Bounded-concurrency compute across the symbols list. Errors on a single
    // symbol are captured for the receipt summary but don't fail the batch.
    const pipe = deps.redis.pipeline();
    let written = 0;
    let skippedErrored = 0;
    let skippedInvalid = 0;
    let firstRowError: string | null = null;

    const runOne = async (symbol: string): Promise<void> => {
      try {
        const candles = await fetchKlines(symbol, interval);
        if (candles.length === 0) {
          skippedInvalid += 1;
          return;
        }
        const rating = computeTechnicalsRating(candles);
        const signal = ratingToSignal(symbol, candles, rating, clock.nowMs());
        pipe.set(
          GLOBAL_KEYS.technicals(symbol, interval),
          JSON.stringify(signal),
          'EX',
          deps.signalTtlSeconds,
        );
        written += 1;
        // Yield the event loop after each symbol's ~7.6ms synchronous indicator
        // compute. Under ROLE=all the api shares this thread, so an unbroken
        // batch of computes tail-latencies the dashboard; a macrotask break lets
        // pending request callbacks interleave. Output is unchanged.
        await new Promise<void>((resolve) => setImmediate(resolve));
      } catch (err) {
        skippedErrored += 1;
        const msg = errorMessage(err) || 'unknown';
        if (firstRowError === null) firstRowError = msg;
      }
    };

    // Bounded-concurrency walk via the shared helper. `runOne` swallows its own
    // per-symbol errors into the receipt counters and never throws, so the
    // helper's `errors` channel stays empty and `collect` runs every symbol.
    await fanOutBounded(symbols, runOne, {
      concurrency: klineConcurrency,
      onError: 'collect',
    });

    let commitError: string | null = null;
    if (written > 0) {
      try {
        await commitPipelineChecked(pipe, 'technicals computeAndCache');
      } catch (err) {
        // A pipeline commit failure (network blip, Redis EXEC error, or a
        // per-command reply error) is the most operator-actionable error this
        // cron can produce; the dashboard promises a non-null `error` on every
        // failure, so the receipt MUST record it and hold the batch as failed.
        commitError = errorMessage(err) || 'pipeline commit failed';
        written = 0;
      }
    }

    const fetchedAtMs = clock.nowMs();
    const allFailed = symbols.length > 0 && written === 0;
    const errorSummary =
      commitError !== null
        ? `pipeline: ${commitError}`
        : allFailed
          ? (firstRowError ?? 'every symbol failed')
          : null;
    const lastFreshAtMs = written > 0 ? fetchedAtMs : priorLastFreshAtMs;
    // Advance the candle-close gate only on a successful compute; a failed
    // batch preserves the prior boundary so the next tick retries.
    const lastComputedCloseMs =
      written > 0 && closedBoundaryMs !== null ? closedBoundaryMs : priorLastComputedCloseMs;

    await writeStatus(
      TechnicalsFetchStatusSchema.parse({
        interval,
        fetchedAtMs,
        requested: symbols.length,
        written,
        skippedErrored,
        skippedInvalid,
        latencyMs: fetchedAtMs - startMs,
        lastFreshAtMs,
        lastComputedCloseMs,
        error: errorSummary,
      }),
    );

    const downtimeMs =
      priorHadError && lastFreshAtMs !== null && priorLastFreshAtMs !== null
        ? fetchedAtMs - priorLastFreshAtMs
        : null;
    deps.logger.info(
      {
        interval,
        requested: symbols.length,
        written,
        skippedErrored,
        skippedInvalid,
        latencyMs: fetchedAtMs - startMs,
      },
      'technicals computeAndCache: committed',
    );
    if (priorHadError && !errorSummary && downtimeMs !== null) {
      deps.logger.info({ interval, downtimeMs, lastFreshAtMs }, 'technicals compute-recovered');
    }
  };
};
