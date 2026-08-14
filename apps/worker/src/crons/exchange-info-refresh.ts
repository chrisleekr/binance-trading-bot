// Exchange-info refresher.
//
// Fetches Binance's public /api/v3/exchangeInfo snapshot, projects each
// symbol's filters into the strategy-core SymbolInfo shape, and writes
// binance:symbol-info:<symbol> to Redis. The tick handler's coldLoad
// reads from these keys on every tick — without this refresher every
// new-profile first tick DLQs with "symbol-info missing in Redis".
//
// Pure public endpoint, no signing. Runs per Binance `mode`: `live` fetches
// production `api.binance.com`, `test` fetches `testnet.binance.vision`. The
// hosts are NOT interchangeable — testnet publishes coarser tickSize / lot
// filters than production, so a test-mode profile that priced orders off
// production filters gets rejected (-1013 PRICE_FILTER). Each mode writes its
// own keyspace (see `buildSymbolInfoKey`).

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import {
  BINANCE_HOSTS,
  parseOrderRateLimits,
  type BinanceMode,
  type ParsedOrderRateLimits,
} from '@app/binance';
import { projectPermissionSets, projectSymbolFilters, type RawSymbolFilter } from '@app/contracts';
import type { SymbolInfo } from '@app/strategy-core';
import { buildSymbolInfoKey } from 'executor/redis-namespace.js';
import type { MetricsSink } from 'metrics/catalog.js';

interface RawSymbol {
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly status: string;
  // Rows are forwarded whole to `projectSymbolFilters`, never read here, so they
  // are typed as that function's own input. A local copy would type-check while
  // omitting a field the projector needs, and a dropped
  // `PERCENT_PRICE_BY_SIDE` multiplier degrades to "band unknown" silently.
  readonly filters?: readonly RawSymbolFilter[];
  /** Unknown: shape-checked by `projectPermissionSets`, never trusted from here. */
  readonly permissionSets?: unknown;
}

interface RawExchangeInfo {
  readonly symbols: readonly RawSymbol[];
  // Binance publishes the account's ORDERS limits alongside the symbol list,
  // and they differ per environment (live 100/10s + 200000/1d, testnet 50/10s
  // + 160000/1d), so they are read here rather than hardcoded.
  readonly rateLimits?: unknown;
}

const EXCHANGE_INFO_PATH = '/api/v3/exchangeInfo';
const FETCH_TIMEOUT_MS = 15_000;
// Mirror the api/exchange-info route filter — Binance occasionally lists
// CJK-tickered pairs that fail the strict SymbolName regex, so the worker
// and SPA agree on the pickable universe.
const TICKER_OK = /^[A-Z0-9]+$/;

// Cold-load reads these keys on every tick and expects a filters object, so a
// symbol with an incomplete filter set (asset-dust pairs) collapses to an
// all-zero set rather than a missing key. Sizing reads a zero stepSize as
// invalid-filters and skips the symbol; every real Binance spot pair carries
// LOT_SIZE + PRICE_FILTER + NOTIONAL, so only untradeable dust pairs land here.
const ZERO_FILTERS: SymbolInfo['filters'] = {
  minPrice: '0',
  maxPrice: '0',
  tickSize: '0',
  minQty: '0',
  maxQty: '0',
  stepSize: '0',
  minNotional: '0',
};

// How many symbol names ride the aggregated drift line. The count sits beside
// them, so the truncation is never silent.
const DRIFT_SAMPLE_LIMIT = 20;

/** Symbols this run projected with something missing, accumulated for one log line. */
interface FilterDrift {
  readonly unparseable: string[];
  readonly bandDropped: string[];
}

/**
 * Record a symbol that PUBLISHED filter data the projection could not read.
 *
 * Two distinct drifts, and neither can see the other:
 *
 *  - The projection answers `null` for both an absent list and an unreadable
 *    one, and both collapse to {@link ZERO_FILTERS}, so from the cache alone the
 *    two are the same row. They are not the same event. An absent list is a dust
 *    pair behaving normally and is silent by design, whereas an unreadable
 *    non-empty list means Binance changed a shape the bot parses, and every tick
 *    from then on skips the symbol for unsizeable filters without saying why.
 *  - `PERCENT_PRICE_BY_SIDE` is parsed separately and spread in only on success,
 *    so a garbled or renamed band leaves a NON-NULL filter set that the first
 *    check cannot see. Downstream that band reads as absent, the band refusal
 *    fails open, and the cancel/re-place pair resumes into the same -1013 —
 *    exactly the loop this drift signal exists to catch.
 *
 * Counted per mode only; a symbol label would be one series per listed pair.
 * Only the LOG is deferred to the end of the run: the projection is
 * all-or-nothing, so one upstream field change voids thousands of symbols at
 * once and a per-symbol warn would bury itself.
 */
const recordFilterDrift = (
  deps: ExchangeInfoRefreshDeps,
  mode: BinanceMode,
  raw: RawSymbol,
  filters: ReturnType<typeof projectSymbolFilters>,
  drift: FilterDrift,
): void => {
  if (filters === null) {
    if (!Array.isArray(raw.filters) || raw.filters.length === 0) return;
    deps.metrics?.record('exchange_info_filters_unparseable_total', 1, { mode });
    drift.unparseable.push(raw.symbol);
    return;
  }
  if (
    filters.percentPriceBySide === undefined &&
    Array.isArray(raw.filters) &&
    raw.filters.some((f) => f?.filterType === 'PERCENT_PRICE_BY_SIDE')
  ) {
    deps.metrics?.record('exchange_info_band_unparseable_total', 1, { mode });
    drift.bandDropped.push(raw.symbol);
  }
};

/** One bounded line per refresh run, per drift kind, or nothing when the run was clean. */
const reportFilterDrift = (
  deps: ExchangeInfoRefreshDeps,
  mode: BinanceMode,
  drift: FilterDrift,
): void => {
  if (drift.unparseable.length > 0) {
    deps.logger.warn(
      {
        mode,
        symbols: drift.unparseable.length,
        sample: drift.unparseable.slice(0, DRIFT_SAMPLE_LIMIT),
      },
      'exchange-info-refresh: symbols published filters that could not be projected; they will be treated as unsizeable and skipped',
    );
  }
  if (drift.bandDropped.length > 0) {
    deps.logger.warn(
      {
        mode,
        symbols: drift.bandDropped.length,
        sample: drift.bandDropped.slice(0, DRIFT_SAMPLE_LIMIT),
      },
      'exchange-info-refresh: symbols published a PERCENT_PRICE_BY_SIDE band that could not be projected; their protective stops lose the band check',
    );
  }
};

const projectSymbol = (
  deps: ExchangeInfoRefreshDeps,
  mode: BinanceMode,
  raw: RawSymbol,
  drift: FilterDrift,
): SymbolInfo => {
  // Omit the key entirely when the payload is absent or malformed. An empty
  // array would read as "no sets published", which the tradability check
  // treats as permitted, so an all-or-nothing projection keeps the absent
  // case and the unreadable case identically fail-open.
  const permissionSets = projectPermissionSets(raw.permissionSets);
  const filters = projectSymbolFilters(raw.filters);
  recordFilterDrift(deps, mode, raw, filters, drift);
  return {
    symbol: raw.symbol,
    baseAsset: raw.baseAsset,
    quoteAsset: raw.quoteAsset,
    status: raw.status,
    filters: filters ?? ZERO_FILTERS,
    ...(permissionSets === null ? {} : { permissionSets }),
  };
};

export interface ExchangeInfoRefreshDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly host?: string;
  // Which Binance environment to fetch and which keyspace to write. Defaults
  // to `live` so existing callers are unchanged.
  readonly mode?: BinanceMode;
  /** Optional / no-op when unwired, same as every other injection point. */
  readonly metrics?: MetricsSink;
}

export interface ExchangeInfoRefreshResult {
  readonly fetched: number;
  readonly written: number;
  readonly skipped: number;
  readonly deleted: number;
  /**
   * The `ORDERS` rows for this mode. Carried on the result rather than written
   * to Redis: the only consumer is the per-account order governor built in the
   * same worker process, and this refresh is primed before any tick runs.
   * Empty when the payload omits or malforms them, which builds an inert
   * governor — no invented fallback numbers.
   */
  readonly orderRateLimits: ParsedOrderRateLimits;
}

/**
 * Combine the live + test refreshers into the single closure the boot context,
 * prime path, and recurring cron drive. The live refresh is load-bearing — a
 * throw propagates so BullMQ retries and prime-before-ticks falls back. The
 * test refresh is best-effort: a testnet outage logs a warn and still resolves
 * to the live result, so it can never block the live universe. Extracted from
 * boot assembly so the branch is unit-testable.
 */
export const combineExchangeInfoRefresh =
  (
    refreshLive: () => Promise<unknown>,
    refreshTest: () => Promise<unknown>,
    logger: Logger,
  ): (() => Promise<unknown>) =>
  async () => {
    const result = await refreshLive();
    try {
      await refreshTest();
    } catch (err) {
      logger.warn(
        { err: err },
        'exchange-info-refresh: test-mode refresh failed (live refresh succeeded)',
      );
    }
    return result;
  };

export const createExchangeInfoRefresh = (
  deps: ExchangeInfoRefreshDeps,
): (() => Promise<ExchangeInfoRefreshResult>) => {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const mode = deps.mode ?? 'live';
  const host = deps.host ?? BINANCE_HOSTS[mode];

  return async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let body: RawExchangeInfo;
    try {
      const res = await fetchImpl(`${host}${EXCHANGE_INFO_PATH}`, {
        headers: { accept: 'application/json' },
        // Unsigned, but this body now sets the account's ORDERS ceiling as well
        // as the symbol filters. A followed redirect would let another host
        // choose our order budget, and an inflated limit is the one direction
        // the governor exists to prevent. Binance never redirects here.
        redirect: 'error',
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`exchange-info-refresh: upstream ${res.status} ${res.statusText}`);
      }
      body = (await res.json()) as RawExchangeInfo;
    } finally {
      clearTimeout(timer);
    }

    const symbols = Array.isArray(body?.symbols) ? body.symbols : [];
    // Refuse to act on an empty/malformed upstream payload — Binance
    // occasionally returns 200 with no `symbols` array during partial
    // outages. Without this guard the stale-key cleanup below would
    // SCAN+DEL every existing `binance:symbol-info:*` key, wiping the
    // cache in one bad fetch. Throwing routes through BullMQ retry +
    // DLQ; the previous cache stays intact until a healthy response
    // arrives.
    if (symbols.length === 0) {
      throw new Error('exchange-info-refresh: upstream returned 0 symbols; refusing to wipe cache');
    }
    const currentKeys = new Set<string>();
    const queued: string[] = []; // parallel to pipe.set() ordering for error reporting
    let skipped = 0;
    const drift: FilterDrift = { unparseable: [], bandDropped: [] };
    const pipe = deps.redis.pipeline();
    for (const raw of symbols) {
      if (!raw?.symbol || !TICKER_OK.test(raw.symbol)) {
        skipped += 1;
        continue;
      }
      const key = buildSymbolInfoKey(raw.symbol, mode);
      pipe.set(key, JSON.stringify(projectSymbol(deps, mode, raw, drift)));
      currentKeys.add(key);
      queued.push(key);
    }
    reportFilterDrift(deps, mode, drift);
    // Inspect every per-command reply. A partial pipeline failure
    // (OOM, MOVED in cluster, broken connection mid-stream) would
    // otherwise be invisible: `currentKeys` would claim the symbol
    // was written, but Redis wouldn't have it — and the stale-key
    // cleanup below would NOT delete it (since it's in currentKeys),
    // so the next cold-load miss surfaces a misleading "symbol not
    // in exchangeInfo after refresh" error. Throw on any per-command
    // error so the BullMQ retry loop engages.
    const replies = (await pipe.exec()) ?? [];
    let written = 0;
    for (let i = 0; i < replies.length; i += 1) {
      const reply = replies[i];
      if (!reply) continue;
      const [err] = reply;
      if (err) {
        throw new Error(
          `exchange-info-refresh: redis SET failed for ${queued[i] ?? '<unknown>'}: ${err.message}`,
        );
      }
      written += 1;
    }

    // Delete keys for symbols Binance no longer lists. Without this,
    // a delisted pair (e.g. BUSDUSDT) lingers in Redis indefinitely
    // and cold-load returns ghost market data instead of failing loud.
    // SCAN is cursor-based; non-blocking under load.
    let deleted = 0;
    let cursor = '0';
    do {
      const [next, batch] = await deps.redis.scan(
        cursor,
        'MATCH',
        buildSymbolInfoKey('*', mode),
        'COUNT',
        500,
      );
      cursor = next;
      const stale = batch.filter((k) => !currentKeys.has(k));
      if (stale.length > 0) {
        await deps.redis.del(...stale);
        deleted += stale.length;
      }
    } while (cursor !== '0');

    const orderRateLimits = parseOrderRateLimits(body.rateLimits);
    deps.logger.info(
      {
        mode,
        fetched: symbols.length,
        written,
        skipped,
        deleted,
        orderWindows: orderRateLimits.windows,
      },
      'exchange-info-refresh: cache updated',
    );
    return { fetched: symbols.length, written, skipped, deleted, orderRateLimits };
  };
};
