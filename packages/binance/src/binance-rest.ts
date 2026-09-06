// Minimal Binance REST client.
//
// Covers what the worker actually calls:
//   - GET  /api/v3/openOrders          (resync open orders)
//   - GET  /api/v3/account             (account-snapshot-safety cron)
//   - POST /api/v3/order               (place order)
//   - POST /api/v3/order/cancelReplace (atomic cancel and successor order)
//   - DELETE /api/v3/order             (cancel order)
//   - GET  /api/v3/klines              (cold-start indicator candles)
//   - POST /sapi/v1/asset/dust-btc     (list dust-convertible balances)
//   - POST /sapi/v1/asset/dust         (convert dust to BNB)
//
// Captures `X-MBX-USED-WEIGHT-1M` from every response so the executor's
// per-account weight limiter has fresh data without an extra round-trip.
//
// Every call declares whether it is signed, and that flag alone decides whether
// the API key is attached. The unsigned market-data reads (klines, tickers,
// trades, depth, and the time resync) go out with no credential at all: Binance
// would ignore one, so sending it only widens where the key can be observed.
//
// Binance REST docs: https://developers.binance.com/docs/binance-spot-api-docs/rest-api

import { createHmac } from 'node:crypto';
import { BINANCE_HOSTS, type BinanceMode } from './endpoints.js';
import type { OrderRateGovernor, WeightGovernor } from './rate-limit/index.js';
import { errorMessage } from '@app/core/error';
import { sleep as defaultSleep } from '@app/core/sleep';

/**
 * Selects the Binance environment a client is bound to. `live` and `test`
 * have separate URL hosts, separate credentials, and separate listenKeys; a
 * client built for one cannot reach the other so the mode is a constructor
 * input rather than a per-call argument.
 */
export { BINANCE_HOSTS, BINANCE_WS_API_HOSTS, BINANCE_WS_HOSTS } from './endpoints.js';
export type { BinanceMode } from './endpoints.js';

/**
 * Hard ceiling on a single REST round-trip. Without it a stalled TCP
 * connection hangs the awaiting caller forever — which freezes a self-
 * rescheduling cron's chain (a missed market-trend snapshot) or a profile's
 * in-process job chain. A timeout converts the hang into a normal rejection,
 * which every caller already handles. 10s mirrors the public-klines fetch and
 * dwarfs a healthy sub-second Binance response, so it only fires on a stall.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Bounded retry for transient failures on idempotent GETs only: an empty or
 * non-JSON 200 body (Binance edge occasionally returns a 200 with an empty
 * body) and transient network errors. GET-only so order placement/cancel
 * (POST/PUT/DELETE) keep their exact single-shot semantics — a timed-out POST
 * must never silently re-fire. Constants mirror `public-klines.ts`.
 */
const GET_RETRY_ATTEMPTS = 2;
const GET_RETRY_BASE_MS = 500;
const GET_RETRY_MAX_MS = 2_000;

/** Transient network error messages worth one more attempt. Mirrors `public-klines.ts`. */
const TRANSIENT_NETWORK_RE = /timeout|abort|fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN/i;

/**
 * Per-account API credentials. Held as `readonly` so a bound client cannot
 * have its identity mutated mid-session by a caller that accidentally
 * shares a config object across profiles.
 */
export interface BinanceCredentials {
  /** Public identifier sent in the `X-MBX-APIKEY` header on signed requests. Unsigned market-data calls carry no key, so a client built for those alone works with an empty string. */
  readonly apiKey: string;
  /** HMAC-SHA256 signing key. Never logged; only used to sign query strings on private endpoints. */
  readonly secretKey: string;
}

/**
 * Mutable side-channel for things Binance returns out-of-band. Currently
 * carries the most-recent `X-MBX-USED-WEIGHT-1M` so the per-account weight
 * limiter can decide whether to throttle the next call without making an
 * extra round-trip to read the header.
 */
export interface BinanceCallContext {
  /** Last-seen `X-MBX-USED-WEIGHT-1M` value, undefined until the first response is observed. */
  weightUsed1m: number | undefined;
}

/**
 * Public surface the worker (and any future Binance-needing harness)
 * consumes. Defined as an interface, not a class, so the test suite can
 * supply a stub without subclassing and so a future second exchange could,
 * in principle, satisfy the same shape — but multi-exchange support is
 * explicitly out of scope today.
 */
export interface BinanceRestClient {
  /**
   * Build a signed ws-api request payload. The caller serialises it via
   * `JSON.stringify` and sends it on a WS connected to
   * `BINANCE_WS_API_HOSTS[mode]`. The helper centralises `timestamp` +
   * `signature` so callers don't redo the math. Values are accepted as
   * `string | number | { toString(): string }` so a `Decimal` price or
   * quantity passes through without an explicit cast — `buildQs`
   * coerces via `URLSearchParams` which calls `.toString()`.
   */
  signWsApiPayload(
    id: string,
    method: string,
    extraParams?: Record<string, string | number | { toString(): string }>,
  ): { id: string; method: string; params: Record<string, string | number> };
  /** Reconciles in-memory state against truth after a worker restart or WS gap; the resync cron is the canonical caller. */
  getOpenOrders(symbol?: string): Promise<readonly OpenOrderDto[]>;
  /** Surfaces Binance's authoritative balances so the account-snapshot-safety cron can detect drift against our derived view. */
  getAccount(): Promise<AccountDto>;
  /** Submits a new order. The `clientOrderId` discipline lives at the call site so the executor can guarantee idempotency across retries. */
  placeOrder(params: PlaceOrderParams): Promise<PlaceOrderDto>;
  /** Atomically cancels a resting order and submits its successor with `STOP_ON_FAILURE`, avoiding a naked window between separate requests. */
  cancelReplaceOrder(params: CancelReplaceParams): Promise<CancelReplaceDto>;
  /** Cancels by Binance's numeric `orderId`; the executor maps from `clientOrderId` before calling so cancel is unambiguous after a restart. */
  cancelOrder(params: { symbol: string; orderId: number }): Promise<CancelOrderDto>;
  /** Queries one order's authoritative terminal state by numeric `orderId`. Used when a cancel races a fill (`-2011`) so the local row records the true status (FILLED vs CANCELED) and executed quantity, not a guess. */
  /**
   * `GET /api/v3/order` accepts EITHER key. `origClientOrderId` is the only way
   * to ask "did the order I sent actually land?" after a transport failure, when
   * Binance's numeric id never reached us but our own client id is known.
   */
  getOrder(
    params: { symbol: string; orderId: number } | { symbol: string; origClientOrderId: string },
  ): Promise<OpenOrderDto>;
  /**
   * Fetches historical candles. The worker seeds the indicator window on
   * cold-start with `limit`; the API's chart endpoint passes
   * `startTime`/`endTime` to honour the operator's requested window.
   */
  getKlines(params: {
    symbol: string;
    interval: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<ParsedKline[]>;
  /**
   * Fetches the 24-hour rolling-window market statistics for one symbol.
   * Unsigned public endpoint; the symbol-detail header reads it to render
   * the Binance-style price/change/high/low/volume ticker strip.
   */
  getTicker24hr(symbol: string): Promise<Ticker24hrDto>;
  /**
   * Fetches the 24-hour statistics for EVERY symbol in one unsigned call (no
   * symbol param). The discovery generator reads the whole market once per
   * refresh to rank gainers within the liquidity floor. Heavier weight (80).
   * `signal` bounds the rate-limit wait and the fetch together, so a caller on
   * a self-rescheduling cron cannot wedge forever on a saturated weight budget.
   */
  getAllTickers24hr(signal?: AbortSignal): Promise<readonly Ticker24hrDto[]>;
  /**
   * Last traded price for each of `symbols`, in ONE unsigned call.
   *
   * Exists for readers that need a price the live miniTicker cache cannot supply. That cache is written only by the market stream and its keys expire in 60s, so it is empty for every symbol at cold boot — exactly when the boot sweep's dust value bounds are asked to judge whether a holding is real.
   *
   * @param symbols - Trading pairs to price. An empty list resolves to an empty result without touching the network, because a request carrying neither `symbol` nor `symbols` means "every pair on the exchange" to Binance.
   * @returns One row per symbol the exchange answered for. Key on `symbol`, never on position: Binance's documentation does not state whether the batch form omits a member it does not list or rejects the whole request, so a caller that cannot tolerate the whole batch failing over one unknown pair must degrade per symbol itself.
   */
  getPriceTickers(symbols: readonly string[]): Promise<readonly PriceTickerDto[]>;
  /**
   * Fetches the most recent public trades for a symbol, newest last.
   * Unsigned public endpoint; the symbol-detail recent-trades panel renders
   * them. `limit` caps the row count (Binance allows up to 1000).
   */
  getRecentTrades(symbol: string, limit: number): Promise<RecentTradeDto[]>;
  /**
   * Lists the account's own trades for a symbol, oldest first. Signed
   * USER_DATA endpoint. The worker calls this on a user-stream reconnect to
   * backfill fills Binance never replays on the stream: `fromId` bounds the
   * query to trades after the last-adopted one, `limit` caps the page
   * (Binance allows up to 1000).
   */
  getMyTrades(params: {
    symbol: string;
    fromId?: number;
    limit?: number;
  }): Promise<readonly MyTradeDto[]>;
  /**
   * Reads the commission rates Binance applies to one symbol on this account. Signed USER_DATA endpoint, weight 20.
   *
   * The only source of the rate behind a fill. `myTrades` reports the commission AMOUNT and the asset it was charged in but never the rate, so a commission taken in a third asset — BNB on a discounted account — carries nothing that values it in quote terms. This table does, and because it is a rate rather than a price it stays correct for a historic fill in a way no current ticker can be.
   */
  getCommissionRates(symbol: string): Promise<CommissionRatesDto>;
  /**
   * Fetches the current order-book depth for a symbol, the resting bid and ask levels. Unsigned public endpoint; the symbol-detail order-book panel renders it.
   *
   * `limit` is the level count per side, and any integer is honoured rather than a fixed set of allowed values: Binance documents `Default: 100; Maximum: 5000` and clips a larger request to 5000 entries. It is also what prices the call, because the weight is banded by it, so asking for more levels is never free. See {@link depthWeight}.
   */
  getDepth(symbol: string, limit: number): Promise<OrderBookDto>;
  /**
   * Lists the balances Binance currently allows converting to BNB (the
   * "dust" set) with per-asset BTC/BNB valuations. SAPI endpoint — available
   * on live only, not the Spot testnet.
   */
  getDustBtc(): Promise<DustBtcDto>;
  /**
   * Converts the given assets' free balances to BNB. SAPI endpoint — live
   * only. `assets` expands to repeated `asset` query params.
   */
  convertDust(assets: readonly string[]): Promise<DustConvertDto>;
  /** Exposes the mutable call-context so the weight limiter can read `weightUsed1m` without us having to thread it through every method. */
  ctx(): BinanceCallContext;
}

/**
 * Subset of Binance's `/openOrders` response we actually consume. We do not
 * model every field Binance returns; trimming here keeps the executor's
 * decision logic from accidentally depending on fields we do not own.
 */
export interface OpenOrderDto {
  /** Trading pair, e.g. `BTCUSDT`. */
  readonly symbol: string;
  /** Binance-assigned numeric id; the only stable handle for cancel calls. */
  readonly orderId: number;
  /** Caller-supplied id; we set this so retries can de-duplicate without a Binance round-trip. */
  readonly clientOrderId: string;
  readonly side: 'BUY' | 'SELL';
  /** Wire string; we do not narrow because Binance keeps adding order types. */
  readonly type: string;
  /** Decimal-as-string. Money-math packages revive these as `Decimal`. */
  readonly price: string;
  /** Decimal-as-string. Money-math packages revive these as `Decimal`. */
  readonly origQty: string;
  /** Decimal-as-string. Money-math packages revive these as `Decimal`. */
  readonly executedQty: string;
  /** Wire string; the executor maps to its own state machine. */
  readonly status: string;
  /** Decimal-as-string. Empty for non-stop orders. */
  readonly stopPrice: string;
  /**
   * Trailing distance in basis points. Binance returns it only on trailing-stop
   * orders, so absence is the normal case and means "not a trailing order".
   * Reading it back is what makes a resting trailing stop's distance decidable —
   * it carries no trigger price to compare against.
   */
  readonly trailingDelta?: number;
  /** Server-side timestamp; useful for staleness checks during reconciliation. */
  readonly time: number;
  /** Server-side last-modification timestamp. Equal to `time` for never-touched orders. */
  readonly updateTime: number;
  /** Decimal-as-string. Running total of quote-currency notional (price × executedQty across fills). */
  readonly cummulativeQuoteQty: string;
  /** GTC | IOC | FOK per Binance. Optional only because some legacy endpoints omit it on non-LIMIT rows; treat absence as undefined, not a default. */
  readonly timeInForce?: 'GTC' | 'IOC' | 'FOK';
}

/**
 * Subset of Binance's `/account` response. The commission-rate arrays are
 * deliberately dropped because nothing acts on them.
 */
export interface AccountDto {
  readonly balances: readonly { asset: string; free: string; locked: string }[];
  /** False during a Binance-side trading halt; the executor refuses to place orders when this flips. */
  readonly canTrade: boolean;
  /**
   * Permission tags this account holds, e.g. `['SPOT','TRD_GRP_025']`. A
   * symbol is tradable only when the account holds at least one tag from
   * every set the symbol publishes, so without this the account can bind a
   * symbol Binance will refuse forever. Optional: older accounts and some
   * stubbed responses omit it, and an absent list must fail open rather than
   * block every symbol.
   */
  readonly permissions?: readonly string[];
}

/**
 * Inputs for `placeOrder`. We require `newClientOrderId` (Binance treats it
 * as optional) because the executor's idempotency story depends on it being
 * caller-supplied and stable across retries.
 */
export interface PlaceOrderParams {
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  /** STOP_LOSS_LIMIT is included so trailing-trade can place its stop-loss leg through the same code path. STOP_LOSS is the market-on-trigger form, the only one that accepts a `trailingDelta` with no price. */
  readonly type: 'LIMIT' | 'MARKET' | 'STOP_LOSS' | 'STOP_LOSS_LIMIT';
  readonly price?: string;
  readonly stopPrice?: string;
  readonly quantity: string;
  /**
   * Trailing distance in basis points. Binance accepts a `STOP_LOSS` with
   * `trailingDelta` and NO `stopPrice`, which starts tracking price the moment
   * it is placed. An integer, not a decimal-string: Binance types it `LONG`.
   */
  readonly trailingDelta?: number;
  readonly timeInForce?: 'GTC' | 'IOC' | 'FOK';
  /** Required by us, not by Binance. Drives idempotent retry across worker restarts. */
  readonly newClientOrderId: string;
}

/**
 * Subset of Binance's `placeOrder` response. `fills` is optional because
 * `LIMIT` orders typically return without fills; `MARKET` orders return
 * with at least one fill row.
 */
export interface PlaceOrderDto {
  readonly orderId: number;
  readonly clientOrderId: string;
  // Optional: Binance's ACK response (the default for stop types) omits status.
  // We force newOrderRespType=FULL in placeOrder so it is present in practice,
  // but the type stays honest and callers must default it (see place-order.ts).
  readonly status?: string;
  readonly fills?: readonly { price: string; qty: string }[];
}

/** Inputs for replacing a resting order atomically, so the executor can avoid a naked interval between cancelling the old order and submitting its successor. */
export interface CancelReplaceParams extends PlaceOrderParams {
  readonly cancelOrderId: number;
}

/** Outcome reported for one leg of an atomic cancel-replace request, including a leg that Binance did not attempt after an earlier failure. */
export type CancelReplaceLegResult = 'SUCCESS' | 'FAILURE' | 'NOT_ATTEMPTED';

/** Combined cancel and successor-order response, preserving both leg outcomes so callers can reconcile a partial failure without guessing. */
export interface CancelReplaceDto {
  readonly cancelResult: CancelReplaceLegResult;
  readonly newOrderResult: CancelReplaceLegResult;
  readonly cancelResponse: CancelOrderDto | { readonly code: number; readonly msg: string } | null;
  readonly newOrderResponse: PlaceOrderDto | { readonly code: number; readonly msg: string } | null;
}

/**
 * Subset of Binance's `cancelOrder` response. The executor only needs the
 * confirmation that the order moved out of `NEW`; richer fields (price,
 * filled quantity) are read back from the user-stream event instead.
 */
export interface CancelOrderDto {
  readonly orderId: number;
  readonly status: string;
  // Exchange clock for the cancel. Worker stamps `orders.closed_at` from
  // this rather than wall-clock so the row reflects the moment Binance
  // booked the cancel.
  readonly transactTime: number;
}

/**
 * Named, validated kline. Money fields are decimal-strings (project
 * convention end-to-end), so every sink — chart row, candle insert, ATH
 * window — consumes them with zero conversion and no decimal.js dependency.
 */
export interface ParsedKline {
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

/**
 * Thrown when a kline tuple fails shape/parse validation. A distinct subclass
 * so callers can `instanceof`-catch ingestion drift apart from network errors
 * ({@link BinanceApiError}).
 */
export class KlineParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KlineParseError';
  }
}

// Strict decimal-string: an optional sign then digits with an optional
// fractional part. No `Number()` coercion, so a timestamp (or any non-decimal)
// landing in a money slot is caught rather than silently truncated.
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * Validating decoder for a raw `/api/v3/klines` response. Structural checks
 * only (shape + field kind), deliberately NOT market-data plausibility
 * (`high >= low`, `volume > 0`): Binance can legitimately produce those, and
 * rejecting them would turn benign data into job failures. Throws
 * {@link KlineParseError} on the first malformed row so a layout drift fails
 * loudly at the boundary instead of mis-mapping thousands of candles.
 */
export const parseKlines = (raw: unknown): ParsedKline[] => {
  if (!Array.isArray(raw)) {
    throw new KlineParseError(`klines response is not an array (got ${typeof raw})`);
  }
  return raw.map((row, i): ParsedKline => {
    if (!Array.isArray(row) || row.length < 7) {
      throw new KlineParseError(`kline[${i}]: expected a tuple of length >= 7`);
    }
    const openTimeMs = row[0];
    const closeTimeMs = row[6];
    if (typeof openTimeMs !== 'number' || !Number.isFinite(openTimeMs)) {
      throw new KlineParseError(`kline[${i}]: openTime is not a finite number`);
    }
    if (typeof closeTimeMs !== 'number' || !Number.isFinite(closeTimeMs)) {
      throw new KlineParseError(`kline[${i}]: closeTime is not a finite number`);
    }
    if (openTimeMs > closeTimeMs) {
      throw new KlineParseError(`kline[${i}]: openTime ${openTimeMs} > closeTime ${closeTimeMs}`);
    }
    const money = (slot: number, name: string): string => {
      const v = row[slot];
      if (typeof v !== 'string' || !DECIMAL_RE.test(v)) {
        throw new KlineParseError(
          `kline[${i}]: ${name} is not a decimal-string (got ${String(v)})`,
        );
      }
      return v;
    };
    return {
      openTimeMs,
      closeTimeMs,
      open: money(1, 'open'),
      high: money(2, 'high'),
      low: money(3, 'low'),
      close: money(4, 'close'),
      volume: money(5, 'volume'),
    };
  });
};

/**
 * One row of `GET /api/v3/ticker/price`. The endpoint returns the last traded price and nothing else, which is all a value bound needs and a fraction of the weight of the 24h form.
 */
export interface PriceTickerDto {
  readonly symbol: string;
  /** Last traded price in the quote asset, Decimal-as-string like every other money field on the wire. */
  readonly price: string;
}

/**
 * Subset of `GET /api/v3/ticker/24hr` for a single symbol. Binance returns
 * ~20 fields; we model only the ones the symbol-detail ticker strip renders.
 * Every money field is Decimal-as-string; the web client converts to number
 * only at the display-formatting boundary.
 */
export interface Ticker24hrDto {
  readonly symbol: string;
  readonly lastPrice: string;
  readonly priceChange: string;
  readonly priceChangePercent: string;
  readonly highPrice: string;
  readonly lowPrice: string;
  readonly openPrice: string;
  /** 24h traded volume in the base asset. */
  readonly volume: string;
  /** 24h traded volume in the quote asset. */
  readonly quoteVolume: string;
  /** Best current bid price. Drives the discovery spread filter. */
  readonly bidPrice: string;
  /** Best current ask price. Drives the discovery spread filter. */
  readonly askPrice: string;
}

/**
 * One row of `GET /api/v3/trades` — a recent public trade. `price`/`qty` are
 * Decimal-as-string; the web client converts to number only at the display
 * boundary. `isBuyerMaker` true means the buyer sat on the book (a sell-side
 * taker hit it) — the panel colours the row by that flag.
 */
export interface RecentTradeDto {
  readonly id: number;
  readonly price: string;
  readonly qty: string;
  readonly quoteQty: string;
  readonly time: number;
  readonly isBuyerMaker: boolean;
}

/**
 * `GET /api/v3/myTrades` — one of the account's own executed trades. A
 * Binance order fills as one or more trades; `orderId` groups the trades of
 * one order, `id` is the per-symbol-monotonic trade id used both to bound
 * the next fetch (`fromId`) and to dedupe adoption. `isBuyer` gives the
 * side; `qty`/`quoteQty` are this trade's base/quote amounts.
 */
export interface MyTradeDto {
  readonly id: number;
  readonly orderId: number;
  readonly symbol: string;
  readonly price: string;
  readonly qty: string;
  readonly quoteQty: string;
  readonly commission: string;
  readonly commissionAsset: string;
  readonly time: number;
  readonly isBuyer: boolean;
  readonly isMaker: boolean;
}

/** One commission rate table. `maker`/`taker` is selected by the fill's `isMaker`, `buyer`/`seller` by its `isBuyer`, and Binance charges the SUM of the two selected legs. */
export interface CommissionRateSetDto {
  readonly maker: string;
  readonly taker: string;
  readonly buyer: string;
  readonly seller: string;
}

/**
 * `GET /api/v3/account/commission` — the per-symbol commission rates this account is charged.
 *
 * `discount` is a MULTIPLIER applied to the standard component when the fee is paid in `discountAsset`, not an amount subtracted from it: the commission FAQ states `Standard commission (Discounted) = Standard commission x discount` and the endpoint's own example ships `0.75`. The inline prose calling it a rate the commission is "reduced by" reads the same field the opposite way, and the two differ threefold on a real fill.
 */
export interface CommissionRatesDto {
  readonly symbol: string;
  readonly standardCommission: CommissionRateSetDto;
  readonly taxCommission: CommissionRateSetDto;
  readonly specialCommission: CommissionRateSetDto;
  readonly discount: {
    readonly enabledForAccount: boolean;
    readonly enabledForSymbol: boolean;
    readonly discountAsset: string;
    readonly discount: string;
  };
}

/**
 * `GET /api/v3/depth` — the current order book. `bids`/`asks` are arrays of
 * `[price, quantity]` decimal-string tuples; `bids` descend in price, `asks`
 * ascend. `lastUpdateId` is Binance's snapshot cursor (unused by the panel,
 * kept for completeness).
 */
export interface OrderBookDto {
  readonly lastUpdateId: number;
  readonly bids: readonly (readonly [string, string])[];
  readonly asks: readonly (readonly [string, string])[];
}

/**
 * One row of `POST /sapi/v1/asset/dust-btc` — a balance Binance currently
 * lets the account convert to BNB. `toBTC` is the balance valued in BTC,
 * which the dust-transfer screen uses to rank and threshold the list.
 */
export interface DustAssetDto {
  readonly asset: string;
  readonly assetFullName: string;
  readonly amountFree: string;
  readonly toBTC: string;
  readonly toBNB: string;
  readonly toBNBOffExchange: string;
  readonly exchange: string;
}

/** `POST /sapi/v1/asset/dust-btc` response — the dust-convertible asset set plus its aggregate value. */
export interface DustBtcDto {
  readonly details: readonly DustAssetDto[];
  readonly totalTransferBtc: string;
  readonly totalTransferBNB: string;
  readonly dribbletPercentage: string;
}

/** One converted row in a `POST /sapi/v1/asset/dust` response. */
export interface DustConvertResultDto {
  readonly amount: string;
  readonly fromAsset: string;
  readonly operateTime: number;
  readonly serviceChargeAmount: string;
  readonly tranId: number;
  readonly transferedAmount: string;
}

/** `POST /sapi/v1/asset/dust` response — the outcome of converting the requested assets to BNB. */
export interface DustConvertDto {
  readonly totalServiceCharge: string;
  readonly totalTransfered: string;
  readonly transferResult: readonly DustConvertResultDto[];
}

/** The nested slot the `cancelReplace` error path reads back out of Binance's composite failure body. Declared as its own shape rather than inlined so the optional walk is checked rather than cast at the read site. The leg is `unknown` beyond the two discriminating fields because the two codes put opposite things there: `-2022` puts an error shape, `-2021` puts the cancelled order itself. */
interface CancelReplaceErrorBody {
  readonly data?: {
    readonly cancelResponse?: { readonly code?: unknown; readonly status?: unknown };
  };
}

/**
 * Binance's cancel-leg body from a failed `cancelReplace`, kept whole when it carries a string `status`.
 *
 * A `-2021` means the CANCEL SUCCEEDED and only the successor failed, so this body is the exchange's authoritative record of the order that was just retired: its terminal status, its exchange clock, and how much of it had executed. Discarding it forces the caller to stamp its local row from the worker clock as a plain `CANCELED`, which mis-records a stop that had partially filled — nothing repairs that later, because a partially-filled-then-cancelled order emits no `FILLED` execution report.
 *
 * Typed as the two fields the executor decides on plus the rest of the body verbatim, because the whole body is what gets stored as the local row's `raw`.
 */
export interface CancelReplaceCancelLeg {
  readonly status: string;
  /** Exchange clock for the retirement. Optional because it is Binance's field, not ours, and a body without it must still be usable. */
  readonly transactTime?: number;
  readonly [key: string]: unknown;
}

/**
 * Normalised error payload. We unify HTTP status and Binance error code into
 * one shape so the retry classifier can decide on either axis without the
 * caller having to introspect both an HTTP response and a JSON body.
 */
export interface BinanceErrorPayload {
  readonly status: number;
  readonly code: number;
  readonly msg: string;
  /** The cancel leg's own Binance code, present only for a failed `cancelReplace`. See {@link BinanceApiError.cancelLegCode}. */
  readonly cancelLegCode?: number;
  /** The cancel leg's own response body, present only for a failed `cancelReplace` whose leg carries a string `status`. See {@link BinanceApiError.cancelLeg}. */
  readonly cancelLeg?: CancelReplaceCancelLeg;
}

/**
 * Did Binance receive and refuse the request, or might it have executed it?
 *
 * - `rejected`  — Binance read the request, applied its rules, and answered
 *   with a code. Nothing executed, and a caller may safely re-issue.
 * - `ambiguous` — no such proof. The request may already be live on the
 *   exchange, so re-issuing it risks a SECOND order.
 *
 * The distinction is the difference between re-arming an operator's force-sell
 * and double-selling their position, so it is decided at throw time by the only
 * code that knows whether Binance's answer was actually readable — never
 * re-derived downstream from `code`/`status` heuristics.
 */
export type BinanceCallPhase = 'rejected' | 'ambiguous';

/**
 * Thrown for every non-2xx Binance response. Carries the precomputed
 * `retryable` and `phase` verdicts so the executor's outer retry loop does not
 * have to re-classify HTTP statuses or Binance error codes itself — the policy
 * lives in `classifyRetryable` / `classifyPhase` below and is the single source
 * of truth.
 */
export class BinanceApiError extends Error {
  readonly status: number;
  readonly code: number;
  readonly retryable: boolean;
  /** Whether the request provably did not execute. See {@link BinanceCallPhase}. */
  readonly phase: BinanceCallPhase;
  /**
   * Binance's raw `msg`, kept verbatim and separate from the composed
   * `message`. Some codes are overloaded across unrelated causes (`-2010`
   * covers insufficient balance, a closed market, and a non-permitted
   * symbol), so distinguishing them needs the original text. Carrying it as
   * its own field means no downstream code has to substring-parse the
   * composed message, whose prefix is a formatting detail.
   */
  readonly msg: string;
  /**
   * The cancel leg's OWN Binance code, read out of a failed `cancelReplace`
   * body's `data.cancelResponse.code` and `undefined` for every other call.
   *
   * The outer `-2022` says only "the cancel leg failed", which collapses two
   * opposite states: the resting order is still on the book (a genuine refusal),
   * or it was already gone (`-2011`) and there is nothing left to cancel. The
   * caller's correct recovery differs completely between them, and nothing
   * downstream can recover the distinction once the composite body is discarded.
   */
  readonly cancelLegCode: number | undefined;
  /**
   * The cancel leg's own response BODY, and `undefined` for every other call.
   *
   * Kept alongside {@link cancelLegCode} because the code alone answers only which state we are in, not what the exchange recorded. On a `-2021` the cancel succeeded, so this body is the retired order's authoritative status, clock and executed quantity — the caller closes its local row from it instead of stamping a worker-clocked `CANCELED` over a stop that had partially filled.
   */
  readonly cancelLeg: CancelReplaceCancelLeg | undefined;
  /**
   * `payload` is reified so log redaction can treat the error as a plain
   * shape; `retryable` and `phase` are precomputed at throw-time so the catch
   * site does not depend on the classifiers being importable.
   */
  constructor(payload: BinanceErrorPayload, retryable: boolean, phase: BinanceCallPhase) {
    super(`binance ${payload.status}/${payload.code}: ${payload.msg}`);
    this.name = 'BinanceApiError';
    this.status = payload.status;
    this.code = payload.code;
    this.msg = payload.msg;
    this.retryable = retryable;
    this.phase = phase;
    this.cancelLegCode = payload.cancelLegCode;
    this.cancelLeg = payload.cancelLeg;
  }
}

/**
 * Thrown when a 2xx response body fails to parse as JSON (empty body, or an
 * HTML/error page returned with a 200). A distinct type so the GET retry loop
 * can gate on `instanceof` rather than matching the message string.
 */
export class BinanceNonJsonBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinanceNonJsonBodyError';
  }
}

/**
 * Whether a failed GET is transient enough for one bounded retry: an empty /
 * non-JSON 200 body, or a raw network error (timeout, abort, connection
 * refused). A structured `BinanceApiError` (HTTP status / Binance code) is
 * NOT retried here — its retry policy is the `classifyRetryable` verdict, and
 * message-matching it would double-own that decision.
 */
const isTransientGetError = (err: unknown): boolean => {
  if (err instanceof BinanceNonJsonBodyError) return true;
  if (err instanceof BinanceApiError) return false;
  return err instanceof Error && TRANSIENT_NETWORK_RE.test(err.message);
};

/**
 * Constructor inputs for `createBinanceRest`. `fetchImpl` and `clock` are
 * injected (rather than read from globals) so the test suite can stub
 * network and time deterministically; production callers omit them.
 */
export interface CreateBinanceRestOptions {
  readonly mode: BinanceMode;
  readonly credentials: BinanceCredentials;
  /** Defaults to the global `fetch`. Tests pass a spy that returns canned `Response`s. */
  readonly fetchImpl?: typeof fetch;
  /** Binance rejects requests where `now - timestamp > recvWindow`. 5s matches Binance's docs default. */
  readonly recvWindow?: number;
  /** Defaults to `Date.now()`. Tests pin a fixed instant so signed query strings are deterministic. */
  readonly clock?: { nowMs(): number };
  /**
   * Optional shared per-IP weight governor. When supplied, every REST call
   * reserves its documented weight (see `WEIGHT` table in this module)
   * before issuing the request. Lets tick + cron + cold-load callers
   * share one rolling-60s budget instead of independently 429-ing.
   */
  readonly weightGovernor?: WeightGovernor;
  /**
   * Optional per-ACCOUNT order-rate governor. Binance meters order placement
   * against an `ORDERS` budget that is separate from `REQUEST_WEIGHT` and
   * scoped to the UID rather than the IP, so this one is NOT shared across
   * accounts the way `weightGovernor` is. A cancel does not move the budget,
   * so only placements charge it. Omit it and order calls run unaccounted,
   * which is the posture when exchangeInfo's `ORDERS` rows could not be read.
   */
  readonly orderGovernor?: OrderRateGovernor;
  /**
   * Backoff delay between GET retries. Defaults to a real `setTimeout` sleep;
   * tests inject a no-op so the retry path runs without wall-clock waits.
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Weight to reserve for each call SHAPE, sourced from Binance spot API docs except the two SAPI entries below. The shape rather than the endpoint is the unit because one endpoint can cost differently depending on what the request asks for, so each form gets its own named constant: `openOrders` vs `openOrdersAll` and `ticker24hr` vs `tickerAll`. Only `getOpenOrders` chooses between a pair at the call site; the two ticker forms are reached through separate methods that each hardcode one. `tickerPrice` is 4, the batch band, because `getPriceTickers` only ever sends the `symbols=[...]` form, which leaves the cheaper singular-`symbol` band unreachable from this client. A cost banded over a CONTINUOUS parameter cannot be a constant at all and gets a pricing function instead: `GET /api/v3/depth` is priced by {@link depthWeight}. `klines` and `recentTrades` take a `limit` and still sit here because Binance charges them flat, 2 and 25, at any limit. `dustBtc` and `dustConvert` are SAPI endpoints, rate-limited per UID rather than weighted at all, so their 1 is a placeholder that keeps the call admitted through the governor, not a documented cost.
 */
const WEIGHT = {
  klines: 2,
  account: 20,
  ticker24hr: 2,
  // `/api/v3/ticker/price`. Binance charges 2 only for the singular `symbol` form; the batch form omits `symbol` entirely, which is the 4 band. The governor is consume-and-decay with no release path, so an under-charge here cannot be corrected later.
  tickerPrice: 4,
  // `/api/v3/ticker/24hr` with no symbol returns every symbol in one call;
  // Binance weights that all-symbols form at 80 (vs 2 for a single symbol).
  tickerAll: 80,
  recentTrades: 25,
  myTrades: 20,
  // `/api/v3/account/commission` (Query Commission Rates). Binance weights this at 20 — heavy for a read, and the fee path can reach it once per symbol on a reconcile pass.
  accountCommission: 20,
  openOrders: 6,
  // `/api/v3/openOrders` with NO symbol returns every open order on the account
  // in one call; Binance weights that account-wide form at 80 (vs 6 for a single
  // symbol), like the all-symbols ticker. Charging the with-symbol 6 for it
  // would under-reserve the governor ~13x.
  openOrdersAll: 80,
  placeOrder: 1,
  cancelReplace: 1,
  cancelOrder: 1,
  // GET /api/v3/order (query a single order). Binance weights this at 4.
  getOrder: 4,
  // SAPI dust endpoints are UID-rate-limited (not weighted); reserve 1 as
  // a placeholder so the call is still admitted through the governor and
  // the budget accounting stays honest.
  dustBtc: 1,
  dustConvert: 1,
} as const;

/** Heaviest band Binance charges for `GET /api/v3/depth`, and therefore the only reservation that can never under-charge. */
const DEPTH_MAX_WEIGHT = 250;

/** Binance's documented `GET /api/v3/depth` weight bands, keyed by the largest `limit` each one covers. Ordered ascending so the first match is the cheapest band that still holds the request. */
const DEPTH_WEIGHT_TIERS = [
  { maxLimit: 100, weight: 5 },
  { maxLimit: 500, weight: 25 },
  { maxLimit: 1_000, weight: 50 },
  { maxLimit: 5_000, weight: DEPTH_MAX_WEIGHT },
] as const;

/**
 * Prices one order-book read from the `limit` it will actually send. The weight governor is consume-and-decay with no release path, so an under-reservation overdraws the shared per-IP budget with nothing able to correct it — a `limit` of 1000 charged at the 1-100 band's 5 would overdraw it tenfold. Deriving the cost here rather than reading a constant means a future caller cannot re-arm that by simply passing a bigger `limit`.
 *
 * @param limit Order-book levels per side the caller is asking for. Binance documents 5000 as the maximum but still answers above it with the response clipped to 5000 levels, and a limit it cannot classify (a non-finite value) matches no band; both fall through to the heaviest band, because over-reserving only defers our own next call while under-reserving spends budget every other account on this IP is sharing.
 * @returns The `REQUEST_WEIGHT` units to reserve before issuing the call.
 */
const depthWeight = (limit: number): number =>
  DEPTH_WEIGHT_TIERS.find((tier) => limit <= tier.maxLimit)?.weight ?? DEPTH_MAX_WEIGHT;

/**
 * Binance forwards a signed request to the matching engine for as long as
 * `serverTime - timestamp <= recvWindow`, so a request whose response we never
 * saw can still be ADMITTED this long after we sent it. Exported because that
 * window, not the transport error, is what decides when "Binance has never heard
 * of this order" becomes conclusive: a probe before it closes can miss an order
 * that is still in flight.
 */
export const DEFAULT_RECV_WINDOW_MS = 5_000;

/**
 * When a signed request was actually SIGNED, and by how much our clock is
 * corrected to Binance's — the two facts a caller needs to reason about a request
 * whose response never arrived, and the two facts only the client knows.
 *
 * `signedAtLocalMs` is a LOCAL-clock reading taken at the moment the timestamp was
 * signed. That is NOT when the caller invoked the method: the weight governor may
 * hold the call for seconds before it is signed, and a -1021 self-heal re-signs it
 * afterwards. Binance measures its `recvWindow` admission window from the SIGNED
 * timestamp (`localNow + timeOffsetMs`), so the local-clock instant after which the
 * request can no longer be admitted is exactly `signedAtLocalMs + recvWindow` — the
 * offset cancels. When a retry re-signed, the LAST signing instant is the one that
 * counts, and it is the one recorded.
 *
 * `timeOffsetMs` is `serverTime - localTime` as last measured by `syncTime` (0 until
 * a resync ever ran), so `signedAtLocalMs + timeOffsetMs` is the send instant on
 * BINANCE's clock — which is the clock every order's `time` field is stamped in.
 */
export interface SignedCallTiming {
  readonly signedAtLocalMs: number;
  readonly timeOffsetMs: number;
}

const SIGNED_AT_KEY = 'binanceSignedAtLocalMs';
const TIME_OFFSET_KEY = 'binanceTimeOffsetMs';

/**
 * Read the {@link SignedCallTiming} the client stamped onto a thrown error.
 * Undefined for a throw that never got as far as signing (a governor abort), or an
 * error from a non-signed call.
 */
export const readSignedCallTiming = (err: unknown): SignedCallTiming | undefined => {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  const signedAtLocalMs = e[SIGNED_AT_KEY];
  const timeOffsetMs = e[TIME_OFFSET_KEY];
  if (typeof signedAtLocalMs !== 'number' || typeof timeOffsetMs !== 'number') return undefined;
  return { signedAtLocalMs, timeOffsetMs };
};

/**
 * Builds a `BinanceRestClient`. The factory shape lets the closure capture
 * `opts.credentials` once and keeps the per-call methods free of
 * boilerplate; signing, weight capture, error classification and
 * `clientOrderId` plumbing all live in the closure rather than the call
 * sites.
 */
/** Query/body params for a REST call. Array values expand to repeated keys. */
type QsParams = Record<string, string | number | readonly string[] | undefined>;

export const createBinanceRest = (opts: CreateBinanceRestOptions): BinanceRestClient => {
  const host = BINANCE_HOSTS[opts.mode];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const recvWindow = opts.recvWindow ?? DEFAULT_RECV_WINDOW_MS;
  const clock = opts.clock ?? { nowMs: () => Date.now() };
  const sleep = opts.sleep ?? defaultSleep;
  const ctx: BinanceCallContext = { weightUsed1m: undefined };

  // Correction added to every signed timestamp so Binance's recvWindow check
  // passes when the host clock has drifted. Mutated only by `syncTime`.
  let timeOffsetMs = 0;
  // Coalesces concurrent resyncs: a -1021 burst across many in-flight signed
  // calls must issue exactly one `/api/v3/time` round-trip, not one per caller.
  let inFlightSync: Promise<void> | undefined;

  const sign = (qs: string): string =>
    createHmac('sha256', opts.credentials.secretKey).update(qs).digest('hex');

  // Resync `timeOffsetMs` from Binance's server clock. Unsigned, no timestamp,
  // so a drifted clock cannot reject the resync itself. The midpoint of the
  // local clock readings taken either side of the fetch removes half the RTT
  // from the estimate, which a one-sided `before`-only reading would carry.
  const syncTime = async (): Promise<void> => {
    if (inFlightSync) {
      await inFlightSync;
      return;
    }
    inFlightSync = (async () => {
      const localBefore = clock.nowMs();
      // Intentionally NOT weight-reserved: this unsigned call is weight 1 and the
      // governor self-corrects from the X-MBX-USED-WEIGHT-1M response header, so a
      // reserve inside the resync could deadlock against a saturated governor.
      const res = await fetchImpl(`${host}/api/v3/time`, {
        method: 'GET',
        // Carries no key, but its answer sets `timeOffsetMs`, which is added to
        // the `timestamp` of every later signed request. A followed redirect
        // would let another host set our signing clock.
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const localAfter = clock.nowMs();
      // Validate before touching `timeOffsetMs`. An unvalidated body would let a
      // non-2xx page or a missing `serverTime` produce `NaN`, which then poisons
      // every later signed `timestamp` until restart. Throw loudly instead so the
      // -1021 self-heal caller surfaces a real error rather than a silent corruption.
      if (!res.ok) {
        throw new Error(`binance time sync failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { serverTime?: unknown };
      if (typeof body.serverTime !== 'number' || !Number.isFinite(body.serverTime)) {
        throw new Error('binance time sync failed: missing serverTime');
      }
      timeOffsetMs = body.serverTime - Math.round((localBefore + localAfter) / 2);
    })();
    try {
      // If the leader's sync rejects, every coalesced waiter observes that
      // rejection; the `finally` clears `inFlightSync` so the next call retries
      // a fresh sync.
      await inFlightSync;
    } finally {
      inFlightSync = undefined;
    }
  };

  // Array values expand to repeated keys (`asset=X&asset=Y`) — the SAPI dust
  // endpoint takes its `asset` list that way. Insertion order is preserved so
  // the HMAC signature is computed over the exact string Binance receives.
  const buildQs = (params: QsParams): string => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === '') continue;
      if (Array.isArray(v)) {
        for (const item of v) sp.append(k, String(item));
      } else {
        sp.append(k, String(v as string | number));
      }
    }
    return sp.toString();
  };

  const call = async <T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    params: QsParams,
    needsSignature: boolean,
    weight: number,
    // Order placement/cancellation reserves with priority so it admits against
    // the full governor ceiling, ahead of the band bulk read crons leave free.
    priority = false,
    // Whether this call spends the account's ORDERS budget. Deliberately NOT
    // folded into `priority`: `priority` covers cancels too (a cancel-before-sell
    // must not stall behind a bulk read), but Binance's ORDERS budget is an
    // UNFILLED ORDER COUNT — a placement adds one, a cancel adds nothing.
    chargesOrderBudget = false,
    // Caller-supplied deadline. When set it governs BOTH the rate-limit
    // admission wait and the fetch, so a caller can bound the whole call —
    // the default fetch timeout only covers the network, not the unbounded
    // governor wait in front of it. Existing callers pass nothing and keep
    // the prior behaviour (default fetch timeout, no admission deadline).
    signal?: AbortSignal,
  ): Promise<T> => {
    // The one ORDERS charge point. Charged once per call rather than per
    // attempt: a -1021 re-issue below can send a second order request that this
    // misses, and the response-header reconciliation is what corrects it.
    //
    // Ahead of the weight reservation because both governors are
    // consume-and-decay with no release path, so whichever runs first is the
    // budget billed for a call that never goes out. Charging weight first bills
    // the SHARED per-IP budget, throttling every other account until it decays;
    // charging ORDERS first bills one unfilled-order slot on this account
    // alone. Neither is free — the weight governor can refuse too (an aborted
    // admission wait, or a cost above the soft ceiling) and nothing refunds the
    // ORDERS unit — but the per-account leak is the smaller blast radius, and it
    // fails closed: an over-count defers a later placement, it never admits an
    // extra one. Undoing the leak entirely needs a real two-phase commit, which
    // no observed failure rate justifies.
    if (chargesOrderBudget && opts.orderGovernor) {
      await opts.orderGovernor.reserve(1, { signal });
    }
    // Reserve the per-IP weight budget before issuing. When no governor
    // is configured, callers run unrestricted — same as before this MR.
    if (opts.weightGovernor) {
      await opts.weightGovernor.reserve(weight, signal ? { priority, signal } : { priority });
    }
    // The local-clock instant this call's timestamp was last SIGNED at — after the
    // governor's admission wait, and re-stamped by a -1021 re-issue. Per-call (not
    // per-client) so concurrent calls cannot overwrite each other's.
    let signedAtLocalMs: number | undefined;
    // Signs + issues one attempt, applying the current `timeOffsetMs` so a
    // resync between attempts takes effect on the retry. Pulled out so the
    // -1021 self-heal below can re-issue with a corrected timestamp.
    const issue = async (): Promise<T> => {
      const merged: QsParams = { ...params };
      if (needsSignature) {
        merged['recvWindow'] = recvWindow;
        signedAtLocalMs = clock.nowMs();
        merged['timestamp'] = signedAtLocalMs + timeOffsetMs;
      }
      let qs = buildQs(merged);
      if (needsSignature) {
        // Signed requests always added recvWindow and timestamp above.
        qs = `${qs}&signature=${sign(qs)}`;
      }
      const url =
        method === 'GET' || method === 'DELETE'
          ? `${host}${path}${qs ? `?${qs}` : ''}`
          : `${host}${path}`;
      // Keyed only when the call is signed. A public endpoint authenticates nothing, so the header buys no access there and costs the credential's confidentiality: the unsigned reads dominate this client's traffic, and each one writes the key into every proxy, gateway and error log between here and Binance.
      //
      // One flag is enough for the endpoints this client calls, NOT because Binance's types line up that way: of its five security types, `USER_STREAM` and `MARKET_DATA` want the key WITHOUT a signature. This client sends neither — REST `userDataStream` moved to ws-api, and every unsigned read here is `NONE`, including `/api/v3/trades`, the `NONE` sibling of the `MARKET_DATA` `historicalTrades`. So `needsSignature` doubles as "needs the key" only for as long as that stays true. Adding a `USER_STREAM` or `MARKET_DATA` call means giving it its own flag; borrowing this one sends it out unkeyed and it fails with -2015.
      const headers: Record<string, string> = needsSignature
        ? { 'X-MBX-APIKEY': opts.credentials.apiKey }
        : {};
      let body: string | undefined;
      if (method === 'POST' || method === 'PUT') {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = qs;
      }
      const res = await fetchImpl(url, {
        method,
        headers,
        body,
        // Never follow a redirect. The Fetch Standard drops `Authorization` on a
        // cross-origin redirect but knows nothing about `X-MBX-APIKEY`, so a
        // redirect off api.binance.com would replay the key of a signed call to
        // the new host. On an unsigned one it would let that host answer for
        // Binance. Binance's REST API never legitimately redirects, so failing
        // is right.
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const weightHeader = res.headers.get('x-mbx-used-weight-1m');
      if (weightHeader) {
        const n = Number.parseInt(weightHeader, 10);
        if (Number.isFinite(n)) ctx.weightUsed1m = n;
      }
      // Binance reports the authoritative per-account order count per window it
      // enforces. Reconciling keeps the governor correct across the two ways our
      // local tally can undercount: orders placed outside this process (the
      // Binance UI), and a re-issued request that landed twice.
      if (opts.orderGovernor) {
        for (const [header, windowMs] of opts.orderGovernor.headerWindows) {
          const raw = res.headers.get(header);
          if (raw === null) continue;
          const n = Number.parseInt(raw, 10);
          if (Number.isFinite(n)) opts.orderGovernor.observe(windowMs, n);
        }
      }
      if (!res.ok) {
        let payload: BinanceErrorPayload = { status: res.status, code: 0, msg: res.statusText };
        // Did we actually read Binance's answer? This is the ONLY place that
        // knows — the `code: 0` default above is indistinguishable from a real
        // code once the error leaves here — so the phase is decided here and
        // carried on the error, never re-inferred from the code downstream.
        let codeRead = false;
        try {
          const j = (await res.json()) as { code?: number; msg?: string };
          if (typeof j.code === 'number') {
            payload = { ...payload, code: j.code };
            codeRead = true;
          }
          if (typeof j.msg === 'string') payload = { ...payload, msg: j.msg };
          // The one composite slot worth keeping. `cancelReplace` nests each leg's own outcome under `data`, and the cancel leg is the difference between a resting order that is still on the book and one that is not — states whose recoveries are opposite. Read only that slot, and only for the endpoint that produces it, so no other call site inherits a field it cannot interpret. Its two shapes are read separately because they mean opposite things: a numeric `code` is the leg's own REFUSAL, while a string `status` is the retired ORDER, which only a `-2021` (cancel succeeded, successor failed) can produce.
          if (path === '/api/v3/order/cancelReplace') {
            const leg = (j as CancelReplaceErrorBody).data?.cancelResponse;
            if (typeof leg?.code === 'number') payload = { ...payload, cancelLegCode: leg.code };
            if (typeof leg?.status === 'string') {
              payload = { ...payload, cancelLeg: leg as unknown as CancelReplaceCancelLeg };
            }
          }
        } catch {
          // body wasn't JSON; ignore
        }
        throw new BinanceApiError(
          payload,
          classifyRetryable(res.status, payload.code),
          classifyPhase(res.status, payload.code, codeRead),
        );
      }
      // Read as text first so a non-JSON success body (testnet HTML on
      // live-only SAPI endpoints; intermittent gateway errors that return
      // 200 with an error page) surfaces with the body excerpt in the
      // error. Otherwise the caller only sees "Failed to parse JSON" with
      // no way to diagnose without re-deploying with extra logging.
      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        const excerpt = text.length > 200 ? `${text.slice(0, 200)}…` : text;
        throw new BinanceNonJsonBodyError(
          `Binance ${method} ${path}: response body was not JSON (${errorMessage(err)}); body=${JSON.stringify(excerpt)}`,
        );
      }
    };
    // Retry only transient failures on idempotent GETs. A re-issue reuses the
    // outer `weightGovernor.reserve` above; the governor self-corrects from the
    // `x-mbx-used-weight-1m` header, same as the -1021 self-heal, so a bounded
    // ≤2-retry under-reservation is harmless. POST/PUT/DELETE never enter here.
    for (let attempt = 0; ; attempt++) {
      try {
        return await issue();
      } catch (err) {
        // -1021 means our timestamp fell outside recvWindow — a host-clock drift,
        // not an order rejection. Binance rejects at its timing-security gate
        // before executing, so nothing was placed; the retry is side-effect-free
        // (and order placement is idempotent via clientOrderId regardless). One
        // shot only: resync the offset, re-issue once, then let a second -1021
        // propagate so a persistent skew cannot loop. Kept out of the generic
        // retry classifier so the two recovery paths never double-wrap.
        if (err instanceof BinanceApiError && err.code === -1021) {
          await syncTime();
          return await issue();
        }
        // `!signal?.aborted`: when the caller's own deadline (the `signal` arg,
        // which bounds the whole call) has fired, its abort matches the transient
        // regex — but retrying would overrun that deadline in an un-abortable
        // `sleep`. A genuine transient stall uses the internal AbortSignal.timeout
        // (no caller `signal`), so this still retries those.
        if (
          method === 'GET' &&
          attempt < GET_RETRY_ATTEMPTS &&
          !signal?.aborted &&
          isTransientGetError(err)
        ) {
          const backoff = Math.min(GET_RETRY_BASE_MS * 2 ** attempt, GET_RETRY_MAX_MS);
          await sleep(backoff);
          continue;
        }
        // Stamp WHEN the request was signed onto the error before it escapes. A
        // caller whose response never arrived (a transport throw) must know how
        // long Binance can still admit the request — and that window is measured
        // from the signed timestamp, not from when the caller invoked us: the
        // governor's admission wait sits in between. Without this, a placement
        // delayed by the governor is declared "never landed" while it is still
        // admissible, and the retry duplicates a live order.
        if (typeof err === 'object' && err !== null && signedAtLocalMs !== undefined) {
          Object.assign(err, {
            [SIGNED_AT_KEY]: signedAtLocalMs,
            [TIME_OFFSET_KEY]: timeOffsetMs,
          });
        }
        throw err;
      }
    }
  };

  return {
    signWsApiPayload(id, method, extraParams) {
      const merged: Record<string, string | number | { toString(): string }> = {
        ...(extraParams ?? {}),
        apiKey: opts.credentials.apiKey,
        timestamp: clock.nowMs(),
      };
      // Sign the URL-encoded `params` string verbatim with
      // HMAC-SHA256(secret). Binance verifies the signature against
      // whatever the client sends; do NOT sort — `URLSearchParams`
      // preserves insertion order and Binance accepts that.
      const qs = buildQs(merged as Record<string, string | number>);
      const signature = sign(qs);
      const params: Record<string, string | number> = {
        ...(merged as Record<string, string | number>),
        signature,
      };
      return { id, method, params };
    },
    async getOpenOrders(symbol) {
      return call<readonly OpenOrderDto[]>(
        'GET',
        '/api/v3/openOrders',
        symbol ? { symbol } : {},
        true,
        // Account-wide (no symbol) costs Binance 80; a single symbol costs 6.
        symbol ? WEIGHT.openOrders : WEIGHT.openOrdersAll,
      );
    },
    async getAccount() {
      return call<AccountDto>('GET', '/api/v3/account', {}, true, WEIGHT.account);
    },
    async placeOrder(params) {
      return call<PlaceOrderDto>(
        'POST',
        '/api/v3/order',
        {
          symbol: params.symbol,
          side: params.side,
          type: params.type,
          price: params.price,
          stopPrice: params.stopPrice,
          trailingDelta: params.trailingDelta,
          quantity: params.quantity,
          timeInForce: params.timeInForce,
          newClientOrderId: params.newClientOrderId,
          // Binance defaults stop types (STOP_LOSS_LIMIT, etc.) to an ACK
          // response with no `status`; FULL forces a `status` field for every
          // type (and still returns `fills` when marketable) so the resting-order
          // insert's NOT NULL status column is always satisfied.
          newOrderRespType: 'FULL',
        },
        true,
        WEIGHT.placeOrder,
        true, // priority: an order must not stall behind a bulk read cron
        true, // charges ORDERS: a placement adds one to the unfilled order count
      );
    },
    /** Atomically cancels the identified resting order and submits its successor with the request body's hard-coded `cancelReplaceMode: 'STOP_ON_FAILURE'`. Under that mode, a failed cancel means Binance never attempts the new-order leg, reports it as `NOT_ATTEMPTED`, and the non-success response rejects this call. The `CancelReplaceDto` is returned only for the HTTP 200 SUCCESS/SUCCESS body, where both legs succeeded. A failed cancel leaves the new order `NOT_ATTEMPTED` and returns HTTP 400 with Binance error code `-2022`; a successful cancel with a failed new order returns HTTP 409 with Binance error code `-2021`. Both failure cases surface as a thrown `BinanceApiError` carrying that code, because `call()` throws on every non-2xx response. From the composite body it keeps `code`, `msg`, and exactly one nested slot: the cancel leg, read two ways. Its own code is exposed as `BinanceApiError.cancelLegCode`, because an outer `-2022` alone cannot tell a genuine refusal from a `-2011` leg; and when that leg carries a string `status` it is the retired ORDER rather than an error, so the whole body is exposed as `BinanceApiError.cancelLeg` — under `-2021` the cancel succeeded, and that body is the only record of what the retired order's terminal status, exchange clock and executed quantity were. Everything else in the composite — `cancelResult`, `newOrderResult`, the new-order response body — is discarded; the `FAILURE` and `NOT_ATTEMPTED` members of `CancelReplaceLegResult` describe Binance's documented response-body shape, not a value this client ever resolves a caller with. The request reserves weight 1 and charges the account's ORDERS unfilled-order budget once per call, matching the placement path because the successor is one new order.
     *
     * @param params - The old order identifier and the successor order details to submit.
     * @returns Binance's combined result for the cancel and successor-order legs.
     */
    async cancelReplaceOrder(params) {
      return call<CancelReplaceDto>(
        'POST',
        '/api/v3/order/cancelReplace',
        {
          symbol: params.symbol,
          side: params.side,
          type: params.type,
          price: params.price,
          stopPrice: params.stopPrice,
          trailingDelta: params.trailingDelta,
          quantity: params.quantity,
          timeInForce: params.timeInForce,
          newClientOrderId: params.newClientOrderId,
          cancelReplaceMode: 'STOP_ON_FAILURE',
          cancelOrderId: params.cancelOrderId,
          newOrderRespType: 'FULL',
        },
        true,
        WEIGHT.cancelReplace,
        true, // Same as placeOrder: an order must not stall behind a bulk read.
        true, // Same as placeOrder: the new leg adds one to the unfilled order count.
      );
    },
    async cancelOrder(params) {
      return call<CancelOrderDto>(
        'DELETE',
        '/api/v3/order',
        { symbol: params.symbol, orderId: params.orderId },
        true,
        WEIGHT.cancelOrder,
        // priority: a cancel frees an asset the order had locked and has no successor
        // waiting on it, so queueing it behind placements delays every order that
        // needed what it releases while buying nothing.
        true,
        // No ORDERS charge: cancelling does not change the unfilled order count.
      );
    },
    async getOrder(params) {
      return call<OpenOrderDto>(
        'GET',
        '/api/v3/order',
        'orderId' in params
          ? { symbol: params.symbol, orderId: params.orderId }
          : { symbol: params.symbol, origClientOrderId: params.origClientOrderId },
        true,
        WEIGHT.getOrder,
      );
    },
    async getKlines(params) {
      return parseKlines(
        await call<unknown>('GET', '/api/v3/klines', params, false, WEIGHT.klines),
      );
    },
    async getPriceTickers(symbols) {
      if (symbols.length === 0) return [];
      return call<readonly PriceTickerDto[]>(
        'GET',
        '/api/v3/ticker/price',
        // JSON-serialised here rather than handed to `buildQs` as an array: that helper expands an array to repeated keys (`symbols=A&symbols=B`), which is right for the SAPI dust endpoint and wrong for this one — Binance wants a single `symbols=["A","B"]`.
        { symbols: JSON.stringify([...symbols]) },
        false,
        WEIGHT.tickerPrice,
      );
    },
    async getTicker24hr(symbol) {
      return call<Ticker24hrDto>(
        'GET',
        '/api/v3/ticker/24hr',
        { symbol },
        false,
        WEIGHT.ticker24hr,
      );
    },
    async getAllTickers24hr(signal) {
      return call<readonly Ticker24hrDto[]>(
        'GET',
        '/api/v3/ticker/24hr',
        {},
        false,
        WEIGHT.tickerAll,
        false,
        false,
        signal,
      );
    },
    async getRecentTrades(symbol, limit) {
      return call<RecentTradeDto[]>(
        'GET',
        '/api/v3/trades',
        { symbol, limit },
        false,
        WEIGHT.recentTrades,
      );
    },
    async getMyTrades(params) {
      // Only forward fromId/limit when set so the signed query string the
      // caller signs matches the one we send (a literal `undefined` would
      // serialise into the qs and break the signature).
      const qs: QsParams = {
        symbol: params.symbol,
        ...(params.fromId !== undefined && { fromId: params.fromId }),
        ...(params.limit !== undefined && { limit: params.limit }),
      };
      return call<readonly MyTradeDto[]>('GET', '/api/v3/myTrades', qs, true, WEIGHT.myTrades);
    },
    async getCommissionRates(symbol) {
      return call<CommissionRatesDto>(
        'GET',
        '/api/v3/account/commission',
        { symbol },
        true,
        WEIGHT.accountCommission,
      );
    },
    async getDepth(symbol, limit) {
      return call<OrderBookDto>(
        'GET',
        '/api/v3/depth',
        { symbol, limit },
        false,
        depthWeight(limit),
      );
    },
    async getDustBtc() {
      return call<DustBtcDto>('POST', '/sapi/v1/asset/dust-btc', {}, true, WEIGHT.dustBtc);
    },
    async convertDust(assets) {
      // Binance rejects the call with -1102 if no `asset` is sent; fail
      // fast with a clear message rather than round-tripping that.
      if (assets.length === 0) {
        throw new Error('convertDust: assets must be a non-empty list');
      }
      return call<DustConvertDto>(
        'POST',
        '/sapi/v1/asset/dust',
        { asset: assets },
        true,
        WEIGHT.dustConvert,
      );
    },
    ctx: () => ctx,
  };
};

// HTTP statuses that mean "the cause is transient — trying again later can
// work". `retryable` says nothing about whether the request took effect.
//
// A 5xx in particular is NOT proof the request was rejected before it could
// affect order state: Binance's spot REST docs say the opposite, that a 5xx
// execution status is UNKNOWN and could have been a success. So this set is
// safe to act on for an IDEMPOTENT call (a GET, where a replay costs nothing),
// and callers of order-mutating endpoints must additionally consult the
// failure PHASE before re-issuing anything.
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);
// Binance error codes that indicate a rate-limit / IP-ban / cancel-busy
// state the caller can recover from by waiting; everything else (e.g.
// -2010 NEW_ORDER_REJECTED) is non-retryable because the order was
// definitively rejected on Binance's side.
const RETRYABLE_BINANCE = new Set([-1003, -1006, -1007, -1015]);

const classifyRetryable = (status: number, code: number): boolean =>
  RETRYABLE_HTTP.has(status) || RETRYABLE_BINANCE.has(code);

// HTTP 418 is Binance's IP ban and 429 its rate-limit warning; -1003 is TOO_MANY_REQUESTS and -1015 TOO_MANY_ORDERS. Narrower than `retryable` on purpose: a 5xx is worth retrying but says nothing about the weight budget, while these four mean the budget is already spent. 418 appears here though not in RETRYABLE_HTTP, because "already banned" is exactly the state a caller must not add load to even though it is not itself a retry signal.
const RATE_LIMIT_HTTP = new Set([418, 429]);
const RATE_LIMIT_BINANCE = new Set([-1003, -1015]);

/**
 * Whether a thrown error means the request-weight budget is already spent, so a caller holding a fan-out fallback must abandon it rather than run it.
 *
 * A `catch` cannot otherwise tell "one bad symbol poisoned a batch" — where retrying members individually is the repair — from a throttle, where those same retries are the harm. Any non-Binance error answers false: an unrecognised failure gets the fallback, which is the behaviour that existed before this predicate.
 *
 * @param err - The caught value, of any shape; only a {@link BinanceApiError} can answer true.
 * @returns True when Binance reported a rate limit or an IP ban.
 */
export const isRateLimitError = (err: unknown): boolean =>
  err instanceof BinanceApiError &&
  (RATE_LIMIT_HTTP.has(err.status) || RATE_LIMIT_BINANCE.has(err.code));

/**
 * Binance error codes whose own documentation says the request's EXECUTION
 * STATUS IS UNKNOWN — reading the code back is not proof the order was refused.
 * Verbatim from the spot API's error list:
 *
 *   -1000 UNKNOWN          "an unknown error occurred while processing the request"
 *   -1001 DISCONNECTED     "internal error; unable to process your request"
 *   -1006 UNEXPECTED_RESP  "...Execution status unknown."
 *   -1007 TIMEOUT          "...Send status unknown; execution status unknown."
 *   -1008 SERVER_BUSY      "server is currently overloaded..."
 *
 * These arrive with a NON-5xx status often enough that keying ambiguity off the
 * HTTP status alone is wrong: -1006/-1007 are also retryable, so a status-only
 * rule would re-arm an operator override for an order Binance says MAY have
 * executed, and place a second live market order. `clientOrderId` is no backstop
 * — Binance dedups it only while the original order is still OPEN.
 */
const UNKNOWN_EXECUTION_CODES = new Set([-1000, -1001, -1006, -1007, -1008]);

/**
 * Whether the request provably did not execute. Three ways that proof is missing:
 *
 *  - HTTP 5xx. Binance's own spot REST docs are explicit that a 5xx execution
 *    status is UNKNOWN and could have been a success.
 *  - We could not read a `code` out of the error body. A body that did not parse
 *    is no proof of anything — least of all that Binance refused the order.
 *  - The code we DID read is one Binance itself documents as "execution status
 *    unknown" (see {@link UNKNOWN_EXECUTION_CODES}). A readable code is proof
 *    of receipt, not of refusal.
 *
 * Anything else means Binance read the request, applied its rules, and answered:
 * proof of receipt AND of refusal. Deliberately independent of `retryable` — the
 * two answer different questions, and a failure can be both retryable and
 * ambiguous (a 5xx is exactly that).
 */
const classifyPhase = (status: number, code: number, codeRead: boolean): BinanceCallPhase =>
  status >= 500 || !codeRead || UNKNOWN_EXECUTION_CODES.has(code) ? 'ambiguous' : 'rejected';
