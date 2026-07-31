import { ExchangeInfoResponse, projectSymbolFilters } from '@app/contracts';
import { BINANCE_HOSTS, type BinanceMode } from '@app/binance';
import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import type { DI } from 'di.js';
import { requireUser } from 'middleware/require-user.js';
import { createApiHono, type ApiHono } from 'types.js';

/**
 * The production cache entry. exchangeInfo is exchange-wide market data, so one
 * entry per mode covers every user/profile and every route that needs it; making
 * the key per-user would cost N round-trips per N users for identical content.
 */
export const EXCHANGE_INFO_REDIS_KEY = 'exchange-info:cache';

/**
 * Mode-scoped cache key. Testnet lists a different symbol universe than
 * production, so one shared entry lets whichever mode populated it first answer
 * for the other until the TTL expires — admitting a pair the account's exchange
 * cannot trade, or refusing one it can. The `-test` sits before the `:` so each
 * mode's cleanup glob cannot match the other's keys, matching the
 * `GLOBAL_KEYS.symbolInfo` grammar.
 */
export const exchangeInfoCacheKey = (mode: BinanceMode): string =>
  mode === 'test' ? 'exchange-info-test:cache' : EXCHANGE_INFO_REDIS_KEY;
/**
 * 5-minute TTL: matches the SPA's `queryDefaults.exchangeInfo()`
 * staleTime, so the route only refetches Binance once every 5 minutes
 * regardless of how many clients are polling the symbol picker.
 */
export const EXCHANGE_INFO_CACHE_TTL_SECONDS = 300;

const route = createRoute({
  method: 'get',
  path: '/exchange-info',
  tags: ['symbols'],
  responses: {
    200: {
      description: 'binance exchangeInfo, narrowed to symbol+base+quote+status',
      content: { 'application/json': { schema: ExchangeInfoResponse } },
    },
  },
});

const RawExchangeInfo = z.object({
  symbols: z.array(
    z
      .object({
        symbol: z.string(),
        baseAsset: z.string(),
        quoteAsset: z.string(),
        status: z.string(),
        // Binance attaches a list of filters per symbol; the PRICE_FILTER
        // row carries `tickSize`. Schema is permissive so an upstream
        // filter-shape change doesn't break the cache load.
        filters: z.array(z.object({ filterType: z.string() }).passthrough()).optional(),
      })
      .passthrough(),
  ),
});

/**
 * Extracts the `tickSize` from a Binance PRICE_FILTER entry. Trailing zeros
 * are kept so the chart can read the decimal count straight off the string
 * (`0.00100000` → 5 decimals, not 3).
 */
const extractTickSize = (
  filters: { filterType: string; [k: string]: unknown }[] | undefined,
): string | null => {
  if (!filters) return null;
  for (const f of filters) {
    if (
      f.filterType === 'PRICE_FILTER' &&
      typeof f['tickSize'] === 'string' &&
      f['tickSize'].length > 0
    ) {
      return f['tickSize'];
    }
  }
  return null;
};

/**
 * Backing store the route + tests both depend on. A Map-backed shim
 * satisfies this in tests; in production it's the raw ioredis client. The
 * narrow surface (just `get` + `set EX <ttl>`) is intentional — every
 * additional Redis op is a TTL-vs-cache contract that future readers have to
 * re-derive.
 */
export interface ExchangeInfoStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<unknown>;
}

/**
 * Cache-aside loader. Single entry-point so the route (production) and the
 * unit tests (in-memory store) drive the same code path; the only thing that
 * varies is `store` and the injected `fetchImpl`.
 *
 * Returns the parsed response body. Throws if the upstream is unreachable or
 * its shape changed in a way the narrow contract refuses to coerce.
 */
export const loadOrFetchExchangeInfo = async (
  store: ExchangeInfoStore,
  mode: BinanceMode,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<z.infer<typeof ExchangeInfoResponse>> => {
  const cacheKey = exchangeInfoCacheKey(mode);
  const cached = await store.get(cacheKey);
  if (cached) {
    // A malformed cache value would otherwise blow up the entire route.
    // Treat parse failure as a cache miss so the next reader refreshes
    // the cache from Binance instead of seeing a 5xx.
    try {
      return ExchangeInfoResponse.parse(JSON.parse(cached));
    } catch {
      // fall through to upstream fetch
    }
  }
  const url = `${BINANCE_HOSTS[mode]}/api/v3/exchangeInfo`;
  // Bound the upstream fetch so a network hang can't pin route execution
  // for the operator. 10s is generous for a non-blocking call but short
  // enough to surface the failure as a 5xx rather than a request that
  // never returns.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`exchangeInfo upstream ${res.status}`);
  const json: unknown = await res.json();
  const parsed = RawExchangeInfo.safeParse(json);
  if (!parsed.success) throw new Error('exchangeInfo upstream shape changed');
  // Binance occasionally lists meme/regional symbols with non-ASCII tickers
  // (e.g. "币安人生USDT"). Those fail the project's strict SymbolName
  // regex on the response schema, so a single bad entry would 422 the
  // whole route. Drop them at the boundary — the operator can't pick a
  // pair they can't type, and downstream code assumes ASCII tickers.
  const isPickable = /^[A-Z0-9]+$/;
  const body = {
    symbols: parsed.data.symbols
      .filter((s) => isPickable.test(s.symbol))
      .map((s) => ({
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        status: s.status,
        filterTickSize: extractTickSize(s.filters),
        // The full sizing/pricing set (with the NOTIONAL/MIN_NOTIONAL fallback the
        // tick-only extractor lacked) so a strategy preview can size an entry.
        filters: projectSymbolFilters(s.filters),
      })),
    fetchedAt: now().toISOString(),
  };
  await store.set(cacheKey, JSON.stringify(body), 'EX', EXCHANGE_INFO_CACHE_TTL_SECONDS);
  return ExchangeInfoResponse.parse(body);
};

/**
 * `GET /exchange-info` — cached Binance exchangeInfo for the symbol picker.
 *
 * One Redis-backed payload shared across profiles (exchangeInfo is exchange-
 * wide, not per-account); the 5-minute TTL matches the frontend's
 * `queryDefaults.exchangeInfo()` so client cache misses can't trigger more
 * than one upstream call every 5 minutes regardless of how many users sit on
 * the picker. Auth is required (every API surface in v1.0 sits behind
 * `requireUser`) but the body carries no user data.
 */
export const exchangeInfoRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/exchange-info', requireUser());

  app.openapi(route, async (c) => {
    const body = await loadOrFetchExchangeInfo(di.redis.raw(), 'live');
    return c.json(body, 200);
  });

  return app;
};
