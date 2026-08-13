// Public surface of the @app/binance package. Apps and packages that need a
// Binance REST client import from here instead of reaching into another app's
// source tree, so a Binance-needing harness (e.g. testnet e2e, future second
// app) is not coupled to apps/worker.

/**
 * Re-exported from `./binance-rest.js` so consumers depend on a stable
 * package entrypoint rather than an internal module path. Adding a new
 * export here is the single, intentional surface change; renaming the
 * internal file then becomes a non-breaking refactor.
 */
export {
  BINANCE_HOSTS,
  BINANCE_WS_API_HOSTS,
  BINANCE_WS_HOSTS,
  BinanceApiError,
  BinanceNonJsonBodyError,
  DEFAULT_RECV_WINDOW_MS,
  KlineParseError,
  createBinanceRest,
  parseKlines,
  readSignedCallTiming,
  type SignedCallTiming,
  type AccountDto,
  type BinanceCallContext,
  type BinanceCallPhase,
  type BinanceCredentials,
  type BinanceErrorPayload,
  type BinanceMode,
  type BinanceRestClient,
  type CancelOrderDto,
  type CreateBinanceRestOptions,
  type DustAssetDto,
  type DustBtcDto,
  type DustConvertDto,
  type DustConvertResultDto,
  type MyTradeDto,
  type OpenOrderDto,
  type OrderBookDto,
  type ParsedKline,
  type PlaceOrderDto,
  type PlaceOrderParams,
  type RecentTradeDto,
  type Ticker24hrDto,
} from './binance-rest.js';

export { resolveBinanceEndpoints, type BinanceEndpointSet } from './endpoints.js';

export {
  createOrderRateGovernor,
  createRedisWeightGovernor,
  createWeightGovernor,
  MAX_RESERVE_WAIT_MS,
  OrderBudgetUnavailableError,
  parseOrderRateLimits,
  RedisUnavailableError,
  type GovernorLogger,
  type OrderRateGovernor,
  type OrderRateGovernorOptions,
  type OrderRateWindow,
  type ParsedOrderRateLimits,
  type RawRateLimit,
  type RedisEvalClient,
  type RedisWeightGovernorOptions,
  type WeightGovernor,
  type WeightGovernorOptions,
} from './rate-limit/index.js';

export { parseUserStreamFrame, type UserStreamEvent } from './user-stream-frame.js';

export {
  fetchClosedKlines,
  type FetchClosedKlinesDeps,
  type PublicKlinesRequest,
} from './public-klines.js';

export {
  createFakeMarketDataPort,
  createKlineFetcher,
  createWsFactory,
  type BinanceWs,
  type BinanceWsFactory,
  type ClosedKline,
  type FakeMarketDataPort,
  type FakeMarketDataPortOptions,
  type KlineFetcher,
  type KlineFetcherOptions,
  type KlineSubscription,
  type KlineWindow,
  type MarketDataPort,
  type MiniTicker,
  type MiniTickerSubscription,
} from './market-data/index.js';
