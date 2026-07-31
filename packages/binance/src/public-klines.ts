// Single source for fetching public (unauthenticated) Binance klines. Both the
// worker's kline-fetcher cold-load and the technicals-compute cron route their
// `GET /api/v3/klines` calls through here, so a Binance shape change or a retry
// policy tweak lives in exactly one place. Strict decode (throws on a malformed
// row), drops the still-forming bar, retries 418/429/5xx honouring Retry-After,
// and reserves the flat klines weight (2).

import { parseKlines } from './binance-rest.js';
import type { ClosedKline } from './market-data/types.js';

/** Flat Binance spot weight for `GET /api/v3/klines` (2, any limit ≤ 1000). */
const KLINES_WEIGHT = 2;

export interface PublicKlinesRequest {
  /** REST host, no trailing slash, e.g. `https://api.binance.com`. */
  readonly baseUrl: string;
  /** Bare symbol, e.g. `BTCUSDT` (no `EXCHANGE:` prefix). */
  readonly symbol: string;
  readonly interval: string;
  readonly limit: number;
}

export interface FetchClosedKlinesDeps {
  /** HTTP fetch. Injected so callers control TLS/agent and tests stub it. */
  readonly fetch: typeof globalThis.fetch;
  /** Wall-clock source. Drives the open-bar drop and Retry-After date math. */
  readonly nowMs: () => number;
  /** Backoff primitive used only on the retry path. */
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * Reserve the per-IP weight budget before each attempt. Optional: when
   * absent the call issues unreserved (a retried call is a separate request,
   * so the reservation runs once per attempt).
   */
  readonly reserveWeight?: (weight: number) => Promise<void>;
}

/** One retry total: enough to absorb a single rate-limit blip; a persistent
 * failure surfaces to the caller. */
const RETRY_ATTEMPTS = 1;
/** Floor backoff (ms) when the response carries no Retry-After header. */
const RETRY_BASE_MS = 500;
/** Hard cap on any Retry-After-derived backoff — the caller reruns soon. */
const RETRY_MAX_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = 'binance-trading-bot/klines';

/** Parse an HTTP Retry-After header (seconds or HTTP-date) into a ms delay, or
 * null when absent/malformed. The numeric branch runs first so a plain "5" is
 * seconds, not a `Date.parse` year. */
const parseRetryAfter = (headerValue: string | null, nowMs: number): number | null => {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, RETRY_MAX_MS);
  }
  const epoch = Date.parse(headerValue);
  if (Number.isFinite(epoch)) return Math.max(0, Math.min(epoch - nowMs, RETRY_MAX_MS));
  return null;
};

/** Binance 418/429 and any 5xx warrant a retry. */
const isRetriableStatus = (status: number): boolean =>
  status === 418 || status === 429 || (status >= 500 && status < 600);

/**
 * Fetch closed klines for one (symbol, interval). Strict-decodes via
 * {@link parseKlines} (throws {@link KlineParseError} on a malformed row),
 * drops the still-forming bar (`closeTimeMs >= now`), retries transient
 * failures honouring Retry-After, and reserves the flat klines weight per
 * attempt. Parse errors are not retried — they reflect an upstream shape
 * change, not a transient blip.
 */
export async function fetchClosedKlines(
  req: PublicKlinesRequest,
  deps: FetchClosedKlinesDeps,
): Promise<ClosedKline[]> {
  const url =
    `${req.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(req.symbol)}` +
    `&interval=${encodeURIComponent(req.interval)}&limit=${req.limit}`;

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      if (deps.reserveWeight) await deps.reserveWeight(KLINES_WEIGHT);
      const res = await deps.fetch(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const now = deps.nowMs();
        return parseKlines(await res.json())
          .filter((k) => k.closeTimeMs < now)
          .map((k) => ({ ...k, isClosed: true as const }));
      }
      if (attempt < RETRY_ATTEMPTS && isRetriableStatus(res.status)) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'), deps.nowMs());
        await deps.sleep(retryAfter ?? RETRY_BASE_MS);
        continue;
      }
      throw new Error(`Binance klines: HTTP ${res.status} for ${req.symbol} @ ${req.interval}`);
    } catch (err) {
      lastErr = err as Error;
      const transient = /timeout|abort|fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i.test(
        lastErr.message,
      );
      if (attempt < RETRY_ATTEMPTS && transient) {
        await deps.sleep(RETRY_BASE_MS);
        continue;
      }
      throw lastErr;
    }
  }
  /* v8 ignore start -- reason: every loop iteration returns or throws; this
     post-loop throw exists only to satisfy the type checker. */
  throw (
    lastErr ?? new Error(`Binance klines: exhausted retries for ${req.symbol} @ ${req.interval}`)
  );
  /* v8 ignore stop */
}
