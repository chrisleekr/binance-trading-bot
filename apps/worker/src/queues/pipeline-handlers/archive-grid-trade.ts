// Pipeline `archive-grid-trade` handler. Snapshots every FILLED order
// for `(profile, symbol)` since the previous archive into a new
// `trade_archive` row. The strategy-specific quote split lands in the row's
// generic `breakdown` jsonb (per `intent:side`) and the raw order summaries in
// the `orders` jsonb. Strategy-agnostic: any strategy's intents archive
// without changes here.
//
// Cost basis: the SQL aggregator sums each SELL fill's `realized_pnl` and
// `cost_basis_quote` columns — cost-basis-matched accounting, not a window
// cashflow difference. The fill-adopter computes those once at fill time from
// the position's avg entry price (`markFilledByBinanceOrderId`), so an adopted
// position (no BUY order row) or a hold spanning an archive boundary can no
// longer inflate profit. A SELL with no known cost basis carries a NULL
// `realized_pnl`, which the aggregator excludes (a conservative under-count,
// surfaced via `summary.missingCostBasis`), never a fabricated zero-cost gain.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { Decimal } from '@app/money';
import type { BinanceMode, BinanceRestClient } from '@app/binance';
import {
  asDecimalString,
  type AccountId,
  type FeeBasis,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import type { Database } from '@app/db';
import { profileRepo, repo } from '@app/db';
import type { SymbolInfo } from '@app/strategy-core';

import { buildSymbolInfoKey } from 'executor/redis-namespace.js';

export interface ArchiveGridTradeJobPayload {
  readonly userId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly symbol: string;
}

export interface ArchiveGridTradeHandlerDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly clock: { nowMs(): number };
  readonly logger: Logger;
  /**
   * Per-profile signed REST client; `null` when the profile or its API key is
   * missing. Used to pull `myTrades` for the archived orders so the cycle's
   * Binance commissions can be summed per asset. A null client (or a failed
   * call) degrades to empty fees rather than failing the archive.
   */
  readonly resolveBinanceClient: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<BinanceRestClient | null>;
}

interface OrderSummary {
  readonly orderId: string;
  readonly binanceOrderId: string;
  readonly clientOrderId: string;
  readonly intent: string;
  readonly side: 'BUY' | 'SELL' | null;
  readonly status: string;
  readonly executedQty: string | null;
  readonly cummulativeQuoteQty: string | null;
  readonly baseCommissionNetted: string | null;
  readonly meta: Record<string, unknown> | null;
  readonly closedAt: string | null;
  readonly raw: unknown;
}

/**
 * Preserve the local order facts needed to audit the archive and prove how well its fees were known.
 *
 * @param row - Filled order row whose Binance snapshot may contain final execution totals and BUY fee-net proof.
 * @returns A JSON-safe order summary with conservative nulls for missing evidence.
 */
const summariseOrder = (row: {
  readonly id: string;
  readonly binanceOrderId: bigint;
  readonly clientOrderId: string;
  readonly intent: string;
  readonly side: string;
  readonly status: string;
  readonly baseCommissionNetted: string | null;
  readonly meta: unknown;
  readonly closedAt: Date | null;
  readonly raw: unknown;
}): OrderSummary => {
  const raw =
    typeof row.raw === 'object' && row.raw !== null ? (row.raw as Record<string, unknown>) : null;
  return {
    orderId: row.id,
    // bigint → decimal string keeps the jsonb audit record lossless while remaining directly renderable by the SPA.
    binanceOrderId: row.binanceOrderId.toString(),
    clientOrderId: row.clientOrderId,
    intent: row.intent,
    side: row.side === 'BUY' || row.side === 'SELL' ? row.side : null,
    status: row.status,
    executedQty: typeof raw?.['executedQty'] === 'string' ? raw['executedQty'] : null,
    cummulativeQuoteQty:
      typeof raw?.['cummulativeQuoteQty'] === 'string' ? raw['cummulativeQuoteQty'] : null,
    baseCommissionNetted: row.baseCommissionNetted,
    // Strategy-owned order metadata, opaque here (TT: `{ gridTradeIndex }`).
    meta: (row.meta as Record<string, unknown> | null) ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    raw: row.raw,
  };
};

/**
 * Load `SymbolInfo` from the Redis snapshot so archiving uses the same exchange metadata as tick processing without another Binance call. A missing key returns null; malformed JSON also returns null after a warning.
 *
 * @param redis - Cache holding exchange-info snapshots.
 * @param symbol - Binance symbol whose assets are required.
 * @param mode - Binance environment selecting the cache namespace.
 * @param logger - Logger used to surface malformed cached JSON.
 * @returns Cached symbol metadata, or null when unavailable or malformed.
 */
export const loadSymbolInfo = async (
  redis: Redis,
  symbol: string,
  mode: BinanceMode,
  logger: Logger,
): Promise<SymbolInfo | null> => {
  const raw = await redis.get(buildSymbolInfoKey(symbol, mode));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as SymbolInfo;
  } catch (err) {
    logger.warn({ symbol, err: err }, 'pipeline_archive_grid_trade_symbol_info_malformed');
    return null;
  }
};

/** Raw per-asset commissions plus the known quote adjustment and how well that adjustment is known. */
interface ResolvedFees {
  /** Per commission asset, total paid as a decimal string (audit record). */
  readonly fees: Record<string, string>;
  /** The known quote-currency adjustment not already present in cost-basis P/L. */
  readonly feesQuote: string;
  /** `exact` only when fill totals match every expected order, every commission treatment succeeded, and none of them needed a rate table to value it. Any gap at all reads `unknown`, never a weaker-but-still-usable tier: a gap means a charge is MISSING from the total, which only ever makes the result look better than it was. */
  readonly feeBasis: FeeBasis;
}

interface FeeResolutionDetails extends ResolvedFees {
  readonly matchedOrderIds: number;
  readonly missingOrderIds: number;
  readonly mismatchedOrders: number;
  readonly unprovenBaseBuyOrders: number;
  readonly malformedOrders: number;
  readonly unpricedTrades: number;
  readonly malformedTrades: number;
}

export interface FeeOrderEvidence {
  readonly binanceOrderId: string;
  readonly side: 'BUY' | 'SELL' | null;
  readonly executedQty: string | null;
  readonly cummulativeQuoteQty: string | null;
  readonly baseCommissionNetted: string | null;
}

/** One commission rate table as Binance publishes it. `maker`/`taker` is selected by the fill's `isMaker` and `buyer`/`seller` by its `isBuyer`; the charge is the SUM of the two selected legs. */
interface CommissionLegs {
  readonly maker: Decimal;
  readonly taker: Decimal;
  readonly buyer: Decimal;
  readonly seller: Decimal;
}

/** The per-symbol commission rates this account is charged, validated into `Decimal` so the fee path never re-parses untrusted text. `discountMultiplier` is the factor the standard component is multiplied BY, and it applies only to a fill Binance charged in `discountAsset`. */
export interface QuoteCommissionRates {
  readonly standard: CommissionLegs;
  readonly tax: CommissionLegs;
  readonly special: CommissionLegs;
  readonly discountAsset: string;
  readonly discountMultiplier: Decimal;
}

/** Resolves the commission rates for one symbol, or reports that they could not be resolved. Async because the rates come from Binance; the pure fee resolver takes the answer as data so it can stay synchronous and side-effect-free. */
export type CommissionRateResolver = (symbol: string) => Promise<QuoteCommissionRates | null>;

/**
 * Parse one rate from the commission payload, rejecting anything outside `[0, 1]`.
 *
 * Both things this parses are fractions: a leg is a share of the fill's quote notional, and the discount is the factor that share is multiplied by. Neither can exceed 1 — a leg above 1 would be a commission larger than the whole trade, and a discount of `25` (the percent spelling of `0.25`) would multiply the standard legs twenty-five-fold. Each would be written as a confident number and then marked complete, so a value outside the range is treated as a payload this code does not understand rather than as arithmetic to perform.
 *
 * @param raw - A single rate or discount factor as it arrived from Binance, untrusted as to type, sign and magnitude.
 * @returns The value, or null when it is not a finite decimal string within `[0, 1]`.
 */
const commissionRate = (raw: unknown): Decimal | null => {
  const value = decimalString(raw, false);
  return value !== null && value.lte(1) ? value : null;
};

/**
 * Parse one four-leg rate table, refusing a partial one.
 *
 * @param raw - The `standardCommission` / `taxCommission` / `specialCommission` member under test.
 * @returns All four legs, or null when any is missing or malformed.
 */
const parseCommissionLegs = (raw: unknown): CommissionLegs | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const table = raw as Record<string, unknown>;
  const maker = commissionRate(table['maker']);
  const taker = commissionRate(table['taker']);
  const buyer = commissionRate(table['buyer']);
  const seller = commissionRate(table['seller']);
  if (maker === null || taker === null || buyer === null || seller === null) return null;
  return { maker, taker, buyer, seller };
};

/**
 * Validate a `GET /api/v3/account/commission` payload into rates the fee path may use, or refuse it entirely.
 *
 * Fail-closed on ANY missing or malformed member, because the failure mode of a partial parse is silent and expensive: a missing leg read as zero produces a confidently wrong fee and then marks the archive row complete on it. Refusing instead routes the commission back to "unpriced", which is exactly the behaviour that already exists for a fee nothing can value.
 *
 * @param raw - The endpoint payload, untrusted; the client casts rather than validates.
 * @returns The validated rates, or null when the payload cannot be trusted in full.
 */
export const parseCommissionRates = (raw: unknown): QuoteCommissionRates | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const payload = raw as Record<string, unknown>;
  const standard = parseCommissionLegs(payload['standardCommission']);
  const tax = parseCommissionLegs(payload['taxCommission']);
  const special = parseCommissionLegs(payload['specialCommission']);
  const discountRaw = payload['discount'];
  if (
    standard === null ||
    tax === null ||
    special === null ||
    typeof discountRaw !== 'object' ||
    discountRaw === null
  ) {
    return null;
  }
  const discount = discountRaw as Record<string, unknown>;
  const discountAsset = discount['discountAsset'];
  const discountMultiplier = commissionRate(discount['discount']);
  if (
    typeof discountAsset !== 'string' ||
    discountAsset.length === 0 ||
    discountMultiplier === null
  ) {
    return null;
  }
  return { standard, tax, special, discountAsset, discountMultiplier };
};

/** The two legs Binance sums for one fill: `isMaker` picks maker or taker, `isBuyer` picks buyer or seller. */
const selectedLegs = (legs: CommissionLegs, isMaker: boolean, isBuyer: boolean): Decimal =>
  (isMaker ? legs.maker : legs.taker).plus(isBuyer ? legs.buyer : legs.seller);

/**
 * The total rate Binance charged on one fill, as a fraction of its quote notional.
 *
 * The discount is a MULTIPLIER on the standard component, not an amount subtracted from it. The commission FAQ states `Standard commission (Discounted) = Standard commission x discount` and the endpoint's own example ships `0.75`; the endpoint's inline prose calling it a rate the commission is "reduced by" reads the same field the opposite way, and on a real fill the two readings differ threefold. Tax and special are summed in undiscounted, which is what the FAQ specifies.
 *
 * The discount is gated on the asset Binance ACTUALLY charged in, not on `enabledForAccount` / `enabledForSymbol`. The observed asset is direct evidence that the discount was taken on this fill; the enabled flags are account state read now and can disagree with a fill recorded before the operator toggled them.
 *
 * There is deliberately no BUY/SELL branch. The FAQ's "received amount" is base quantity on a BUY and quote notional on a SELL, but a BUY's commission is denominated in base, so its quote value is `qty x rate x price` — and `quoteQty = qty x price`. Both sides collapse to `quoteQty x rate`, so branching would restate one expression twice and invite the two copies to drift.
 *
 * @param rates - The validated per-symbol rate tables for this account.
 * @param isMaker - Whether the fill added liquidity, which selects the maker leg over the taker leg.
 * @param isBuyer - Whether the fill was a buy, which selects the buyer leg over the seller leg.
 * @param commissionAsset - The asset Binance charged in; equal to the discount asset it is evidence the discount was applied to this fill.
 * @returns The fraction of the fill's quote notional that was taken as commission.
 */
const effectiveCommissionRate = (
  rates: QuoteCommissionRates,
  isMaker: boolean,
  isBuyer: boolean,
  commissionAsset: string,
): Decimal => {
  const discount =
    commissionAsset === rates.discountAsset ? rates.discountMultiplier : new Decimal(1);
  return selectedLegs(rates.standard, isMaker, isBuyer)
    .mul(discount)
    .plus(selectedLegs(rates.tax, isMaker, isBuyer))
    .plus(selectedLegs(rates.special, isMaker, isBuyer));
};

/**
 * Value one commission in the quote asset when the fill itself, or the account's rate table, supplies enough evidence. Quote fees are 1:1 and base SELL fees use the fill price. A third-asset amount has no execution-time quote rate anywhere in `myTrades`, so it is reconstructed from the rates Binance charged — never from a current ticker, which would price a historic fill at this moment's market and then mark the row complete on it.
 *
 * A base-asset BUY commission is tentatively zero here because the resolver verifies the order's full commission total against the exact amount already folded into cost basis. A SELL base commission is valued at the fill price because it reduces proceeds and is not carried by BUY cost basis.
 *
 * @param fill - The one fill being valued: its validated commission and asset, its fill price and quote notional where those parsed, and its maker/buyer flags, with `isMaker` null when the payload did not state one.
 * @param assets - The base and quote assets of the archived symbol, which decide which of the three treatments applies.
 * @param rates - The account's per-symbol commission rates, or null when they could not be resolved; null leaves a third-asset commission unpriced.
 * @returns The quote adjustment supplied by this fill, or null when parsing or valuation evidence is unavailable.
 */
const valueCommissionInQuote = (
  fill: {
    readonly commission: Decimal;
    readonly commissionAsset: string;
    readonly price: Decimal | null;
    readonly quoteQty: Decimal | null;
    readonly isBuyer: boolean;
    readonly isMaker: boolean | null;
  },
  assets: { readonly baseAsset: string; readonly quoteAsset: string },
  rates: QuoteCommissionRates | null,
): Decimal | null => {
  if (fill.commission.isZero()) return new Decimal(0);
  if (fill.commissionAsset === assets.quoteAsset) return fill.commission;
  if (fill.commissionAsset === assets.baseAsset) {
    if (fill.isBuyer) return new Decimal(0);
    return fill.price === null ? null : fill.commission.mul(fill.price);
  }
  if (rates === null || fill.quoteQty === null || fill.isMaker === null) return null;
  const rate = effectiveCommissionRate(rates, fill.isMaker, fill.isBuyer, fill.commissionAsset);
  // A charge Binance really took cannot have been taken at a zero rate, so the two facts contradict and this table is not evidence for THIS fill. Reachable rather than theoretical: the endpoint reports CURRENT rates while reconcile and backfill value historic fills, so an account moved onto a zero-fee tier since the trade reports zeroes for a commission the row still records. Valuing it anyway would write a zero adjustment beside a positive commission in `fees` and stamp the row complete — self-contradictory evidence, and unrecoverable, because reconciliation only ever re-admits rows whose marker is false.
  if (rate.isZero()) return null;
  return fill.quoteQty.mul(rate);
};

/**
 * Parse one untrusted decimal string without letting `Decimal` accept NaN or Infinity.
 *
 * @param raw - Candidate value from Binance or archived JSON.
 * @param positive - Whether zero must also be rejected.
 * @returns A finite Decimal satisfying the sign rule, or null.
 */
const decimalString = (raw: unknown, positive: boolean): Decimal | null => {
  if (typeof raw !== 'string') return null;
  try {
    const value = new Decimal(raw);
    if (!value.isFinite() || (positive ? value.lte(0) : value.lt(0))) return null;
    return value;
  } catch {
    return null;
  }
};

/**
 * Apply the common fee-evidence rule without converting missing or malformed evidence into a settled zero.
 *
 * @param trades - Retrieved account trades; unrelated order ids are ignored.
 * @param expectedOrders - Filled order ids, sides, exchange totals, and BUY cost-basis proof this result must cover.
 * @param expectedSymbol - Requested Binance symbol; a returned trade from another symbol is not evidence for this archive.
 * @param baseAsset - Base asset used by the deployed cost-basis treatment.
 * @param quoteAsset - Currency for the additional fee adjustment.
 * @param rates - The account's per-symbol commission rates, or null when none were resolved. Passed as DATA rather than fetched here so this function stays pure and synchronous; null reproduces the behaviour that predates rate reconstruction, leaving a third-asset commission unpriced.
 * @returns Raw commission totals, known quote subtotal, the resulting fee tier, and evidence-gap counts.
 */
export const resolveFeesFromTrades = (
  trades: readonly unknown[],
  expectedOrders: readonly FeeOrderEvidence[],
  expectedSymbol: string,
  baseAsset: string,
  quoteAsset: string,
  rates: QuoteCommissionRates | null,
): FeeResolutionDetails => {
  const expectedById = new Map<
    number,
    {
      readonly side: 'BUY' | 'SELL' | null;
      readonly executedQty: Decimal | null;
      readonly cummulativeQuoteQty: Decimal | null;
      readonly baseCommissionNetted: Decimal | null;
    }
  >();
  let malformedOrders = 0;
  for (const order of expectedOrders) {
    const orderId = Number(order.binanceOrderId);
    if (!Number.isSafeInteger(orderId) || orderId < 0 || expectedById.has(orderId)) {
      malformedOrders += 1;
      continue;
    }
    const executedQty = decimalString(order.executedQty, true);
    const cummulativeQuoteQty = decimalString(order.cummulativeQuoteQty, false);
    const baseCommissionNetted = decimalString(order.baseCommissionNetted, true);
    if (
      order.side === null ||
      executedQty === null ||
      (order.baseCommissionNetted !== null && baseCommissionNetted === null)
    ) {
      malformedOrders += 1;
    }
    expectedById.set(orderId, {
      side: order.side,
      executedQty,
      cummulativeQuoteQty,
      baseCommissionNetted,
    });
  }

  const sums = new Map<string, Decimal>();
  const matched = new Set<number>();
  const seenTradeIds = new Set<number>();
  const actualByOrder = new Map<
    number,
    { qty: Decimal; quoteQty: Decimal; baseBuyCommission: Decimal }
  >();
  let feesQuote = new Decimal(0);
  let unpricedTrades = 0;
  let malformedTrades = 0;
  for (const candidate of trades) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const trade = candidate as Record<string, unknown>;
    const orderId = trade['orderId'];
    if (typeof orderId !== 'number' || !Number.isSafeInteger(orderId)) continue;
    const expected = expectedById.get(orderId);
    if (!expected) continue;
    matched.add(orderId);

    const tradeId = trade['id'];
    const commission = decimalString(trade['commission'], false);
    const commissionAsset = trade['commissionAsset'];
    const isBuyer = trade['isBuyer'];
    if (
      trade['symbol'] !== expectedSymbol ||
      typeof tradeId !== 'number' ||
      !Number.isSafeInteger(tradeId) ||
      seenTradeIds.has(tradeId) ||
      commission === null ||
      typeof commissionAsset !== 'string' ||
      commissionAsset.length === 0 ||
      typeof isBuyer !== 'boolean' ||
      expected.side === null ||
      isBuyer !== (expected.side === 'BUY')
    ) {
      malformedTrades += 1;
      continue;
    }
    seenTradeIds.add(tradeId);
    sums.set(commissionAsset, (sums.get(commissionAsset) ?? new Decimal(0)).add(commission));
    const price = decimalString(trade['price'], true);
    const qty = decimalString(trade['qty'], true);
    const quoteQty = decimalString(trade['quoteQty'], false);
    const quoteValue = valueCommissionInQuote(
      {
        commission,
        commissionAsset,
        price,
        quoteQty,
        isBuyer,
        // Read leniently rather than folded into the malformed gate above: a payload without it is only undecidable for the rate-reconstruction arm, and widening the gate would newly reject fills the quote and base treatments value without it.
        isMaker: typeof trade['isMaker'] === 'boolean' ? trade['isMaker'] : null,
      },
      { baseAsset, quoteAsset },
      rates,
    );
    if (quoteValue === null) unpricedTrades += 1;
    else feesQuote = feesQuote.add(quoteValue);
    if (price === null || qty === null || quoteQty === null) {
      malformedTrades += 1;
      continue;
    }
    const actual = actualByOrder.get(orderId) ?? {
      qty: new Decimal(0),
      quoteQty: new Decimal(0),
      baseBuyCommission: new Decimal(0),
    };
    actual.qty = actual.qty.add(qty);
    actual.quoteQty = actual.quoteQty.add(quoteQty);
    if (isBuyer && commissionAsset === baseAsset) {
      actual.baseBuyCommission = actual.baseBuyCommission.add(commission);
    }
    actualByOrder.set(orderId, actual);
  }

  let missingOrderIds = 0;
  let mismatchedOrders = 0;
  let unprovenBaseBuyOrders = 0;
  for (const [orderId, expected] of expectedById) {
    if (!matched.has(orderId)) {
      missingOrderIds += 1;
      continue;
    }
    const actual = actualByOrder.get(orderId);
    if (
      !actual ||
      expected.executedQty === null ||
      !actual.qty.eq(expected.executedQty) ||
      (expected.cummulativeQuoteQty !== null && !actual.quoteQty.eq(expected.cummulativeQuoteQty))
    ) {
      mismatchedOrders += 1;
      continue;
    }
    if (
      expected.side === 'BUY' &&
      !actual.baseBuyCommission.eq(expected.baseCommissionNetted ?? 0)
    ) {
      unprovenBaseBuyOrders += 1;
    }
  }
  // Every way the evidence can fall short, in one predicate. `expectedOrders.length > 0` belongs here rather than reading as a guard clause: a cycle with no expected orders has nothing to have charged a commission against, so a zero total is an absence of evidence and not a measurement of zero.
  const accountedFor =
    expectedOrders.length > 0 &&
    missingOrderIds === 0 &&
    mismatchedOrders === 0 &&
    unprovenBaseBuyOrders === 0 &&
    malformedOrders === 0 &&
    unpricedTrades === 0 &&
    malformedTrades === 0;
  const fees: Record<string, string> = {};
  // `toFixed`, never `toString`: decimal.js switches to exponential notation outside its -7 / 21 exponent thresholds, and a real BNB commission clears the small side while a cumulative quote fee on a sub-cent coin clears the large one. These strings are stored verbatim and interpolated verbatim, so an exponent here reaches a table cell beside a column of fixed decimals and reads as a corrupted value.
  for (const [asset, total] of sums) fees[asset] = asDecimalString(total);
  return {
    fees,
    feesQuote: asDecimalString(feesQuote),
    // `rates === null` distinguishes the two ways of arriving at a complete total. The rates pass runs only when the rate-free pass left something unpriced, so a non-null table here means a third-asset commission really was reconstructed from it; when every commission carried its own valuation evidence, no table was consulted and the total is dated to the fills themselves.
    // A reconstruction never earns `exact`, and no property of the archive window can promote it. The tempting bound is the window itself, but a window bounds each order's LAST fill: `listClosedSince` filters on `closed_at`, while `getMyTrades` returns every tranche of a matched order, so a resting limit order that first filled days before it completed puts a fill of unbounded age inside an arbitrarily narrow window. The table is read at archive time either way, so the tier states what it is rather than guessing how stale it might be.
    feeBasis: !accountedFor ? 'unknown' : rates === null ? 'exact' : 'estimated',
    matchedOrderIds: matched.size,
    missingOrderIds,
    mismatchedOrders,
    unprovenBaseBuyOrders,
    malformedOrders,
    unpricedTrades,
    malformedTrades,
  };
};

/**
 * Resolve fees, consulting the account's commission rates only if a fee turns out to need them.
 *
 * The first pass runs with no rates at all and returns immediately when nothing was left unpriced, which is the ordinary cycle: a quote-asset or base-asset commission carries its own valuation evidence. Only a third-asset commission — BNB on a discounted account — reaches the fetch, so the common path adds no request weight, and a deployment whose commission endpoint is unsupported is never touched unless such a fee actually occurred.
 *
 * @param trades - Retrieved account trades; unrelated order ids are ignored.
 * @param expectedOrders - Filled order ids, sides, exchange totals, and BUY cost-basis proof this result must cover.
 * @param expectedSymbol - Requested Binance symbol, which is also the symbol whose rates are fetched.
 * @param baseAsset - Base asset used by the deployed cost-basis treatment.
 * @param quoteAsset - Currency for the additional fee adjustment.
 * @param fetchRates - Supplies the per-symbol rates on demand; it answers null when they are unavailable, which leaves the first pass's result standing.
 * @returns The same shape the pure resolver returns, valued with rates where any were needed and obtainable.
 */
export const resolveFeesFromTradesWithRates = async (
  trades: readonly unknown[],
  expectedOrders: readonly FeeOrderEvidence[],
  expectedSymbol: string,
  baseAsset: string,
  quoteAsset: string,
  fetchRates: CommissionRateResolver,
): Promise<FeeResolutionDetails> => {
  const withoutRates = resolveFeesFromTrades(
    trades,
    expectedOrders,
    expectedSymbol,
    baseAsset,
    quoteAsset,
    null,
  );
  if (withoutRates.unpricedTrades === 0) return withoutRates;
  const rates = await fetchRates(expectedSymbol);
  if (rates === null) return withoutRates;
  return resolveFeesFromTrades(
    trades,
    expectedOrders,
    expectedSymbol,
    baseAsset,
    quoteAsset,
    rates,
  );
};

/**
 * Build a per-symbol commission-rate resolver for the lifetime of one job.
 *
 * The memo is in-process and dies with the job. A reconcile pass walks up to 500 rows and the rates cannot change inside one pass, so one resolver built before the loop spends at most one weight-20 call per distinct symbol. Redis was the alternative and is over-built for it: caching a value that decides money math would need a staleness window with no invalidation signal, a negative-cache sentinel, and its own key namespace.
 *
 * Fails closed on everything — a non-2xx, a transport error, a shape the parser refuses — and caches the refusal too, so a deployment where the endpoint is unsupported costs one call rather than one per row. A null answer routes the commission back to "unpriced", which is byte-for-byte the behaviour that predates this path.
 *
 * @param client - The account's signed REST client; only the commission-rates call is used.
 * @param logger - Receives one warning per symbol whose rates could not be resolved, so an endpoint that is failing everywhere is visible rather than merely quiet.
 * @returns A resolver that answers at most once per symbol and never throws.
 */
export const createCommissionRateResolver = (
  client: Pick<BinanceRestClient, 'getCommissionRates'>,
  logger: Logger,
): CommissionRateResolver => {
  const memo = new Map<string, QuoteCommissionRates | null>();
  return async (symbol: string): Promise<QuoteCommissionRates | null> => {
    const cached = memo.get(symbol);
    if (cached !== undefined) return cached;
    let rates: QuoteCommissionRates | null = null;
    try {
      rates = parseCommissionRates(await client.getCommissionRates(symbol));
      if (rates === null) {
        logger.warn({ symbol }, 'pipeline_commission_rates_unusable');
      }
    } catch (err) {
      logger.warn({ symbol, err }, 'pipeline_commission_rates_unavailable');
    }
    memo.set(symbol, rates);
    return rates;
  };
};

/**
 * Fetch Binance fills for the archived orders and preserve any raw commission evidence even when the quote adjustment is incomplete. A missing client or failed fetch returns an explicit incomplete result so the archive can still land without claiming exact Net P/L.
 *
 * @param deps - Archive dependencies for account-scoped client resolution and warning logs.
 * @param payload - Ownership and symbol context for the cycle being archived.
 * @param expectedOrders - Filled cycle orders whose commissions and fill totals must all be evidenced.
 * @param baseAsset - Base asset used by the deployed cost-basis treatment.
 * @param quoteAsset - Currency for the additional fee adjustment.
 * @returns Raw commission totals, the known quote subtotal, and the fee tier that evidence earns.
 */
export const resolveFees = async (
  deps: ArchiveGridTradeHandlerDeps,
  payload: ArchiveGridTradeJobPayload,
  expectedOrders: readonly FeeOrderEvidence[],
  baseAsset: string,
  quoteAsset: string,
): Promise<ResolvedFees> => {
  // Every early return lands here, and each of them is a charge nobody looked at rather than a charge that was zero.
  const empty: ResolvedFees = { fees: {}, feesQuote: '0', feeBasis: 'unknown' };
  if (expectedOrders.length === 0) return empty;
  const logCtx = {
    userId: payload.userId,
    profileId: payload.profileId,
    symbol: payload.symbol,
  };
  try {
    const client = await deps.resolveBinanceClient(payload.userId, payload.accountId);
    if (!client) {
      deps.logger.warn(logCtx, 'pipeline_archive_grid_trade_fees_unavailable');
      return empty;
    }
    // `limit: 1000` is Binance's max page; it shrinks the window in which an
    // older cycle's trades fall off the most-recent page and go uncounted.
    const trades = await client.getMyTrades({ symbol: payload.symbol, limit: 1000 });
    const resolved = await resolveFeesFromTradesWithRates(
      trades,
      expectedOrders,
      payload.symbol,
      baseAsset,
      quoteAsset,
      createCommissionRateResolver(client, deps.logger),
    );
    if (resolved.missingOrderIds > 0) {
      deps.logger.warn(
        { ...logCtx, missingOrderIds: resolved.missingOrderIds },
        'pipeline_archive_grid_trade_fees_partial',
      );
    }
    if (resolved.mismatchedOrders > 0 || resolved.malformedOrders > 0) {
      deps.logger.warn(
        {
          ...logCtx,
          mismatchedOrders: resolved.mismatchedOrders,
          malformedOrders: resolved.malformedOrders,
        },
        'pipeline_archive_grid_trade_fees_order_evidence_incomplete',
      );
    }
    if (resolved.unprovenBaseBuyOrders > 0) {
      deps.logger.warn(
        { ...logCtx, unprovenBaseBuyOrders: resolved.unprovenBaseBuyOrders },
        'pipeline_archive_grid_trade_fees_base_buy_unproven',
      );
    }
    if (resolved.unpricedTrades > 0) {
      deps.logger.warn(
        { ...logCtx, unpricedTrades: resolved.unpricedTrades },
        'pipeline_archive_grid_trade_fees_quote_unpriced',
      );
    }
    if (resolved.malformedTrades > 0) {
      deps.logger.warn(
        { ...logCtx, malformedTrades: resolved.malformedTrades },
        'pipeline_archive_grid_trade_fees_malformed',
      );
    }
    return {
      fees: resolved.fees,
      feesQuote: resolved.feesQuote,
      feeBasis: resolved.feeBasis,
    };
  } catch (err) {
    deps.logger.warn({ ...logCtx, err }, 'pipeline_archive_grid_trade_fees_unavailable');
    return empty;
  }
};

/**
 * Archive the newly closed orders for one profile and symbol, stamped with the fee tier its evidence earned.
 *
 * @param deps - Database, Binance, Redis, clock, and logging dependencies.
 * @param payload - Ownership and symbol context for the archive job.
 * @returns Nothing after the row is inserted or a safe no-op is logged.
 */
export const handleArchiveGridTrade = async (
  deps: ArchiveGridTradeHandlerDeps,
  payload: ArchiveGridTradeJobPayload,
): Promise<void> => {
  // Symbol filters differ per Binance mode; read the keyspace matching this
  // profile's mode so a test-mode profile archives against testnet filters, not
  // production. A missing profile (deletion race) fails closed to test.
  const p = await profileRepo(deps.db, payload.userId, payload.accountId, payload.profileId);
  const mode: BinanceMode =
    (await repo.accounts.binanceModeById(deps.db, payload.accountId)) === 'live' ? 'live' : 'test';
  const symbolInfo = await loadSymbolInfo(deps.redis, payload.symbol, mode, deps.logger);
  if (!symbolInfo) {
    // baseAsset/quoteAsset are NOT NULL columns; refusing to archive is
    // better than guessing or splitting the symbol string. The cron
    // primes the cache every 5 min; surface the miss so the operator
    // sees the boot-prime gap rather than a silent ack.
    deps.logger.warn(
      { userId: payload.userId, profileId: payload.profileId, symbol: payload.symbol },
      'pipeline_archive_grid_trade_symbol_info_missing',
    );
    throw new Error(
      `pipeline_archive_grid_trade: symbol-info missing for ${payload.symbol} (refresh cron not yet primed)`,
    );
  }
  // Pin both reads (and the eventual archive row's `archivedAt`) to a
  // single timestamp captured up front. Without an upper bound a row
  // that closes between `summarizeArchiveSince` and `listClosedSince`
  // could land in one query but not the other, leaving the archive
  // row's totals out of sync with its JSONB row list. Pinning also
  // makes the next archive's `since` cutoff consistent with the rows
  // already accounted for: anything closed AFTER `archiveCutoff` rolls
  // into the next archive cleanly.
  const archiveCutoff = new Date(deps.clock.nowMs());
  const since = await p.tradeArchive.latestArchivedAt(payload.symbol);
  const summary = await p.tradeArchive.summarizeArchiveSince(payload.symbol, since, archiveCutoff);
  if (!summary) {
    // No FILLED orders since the last archive. Skip the insert so the
    // dashboard's archive list isn't polluted with empty zero-row
    // entries. Info-level because this is a normal outcome on a
    // duplicate operator click.
    deps.logger.info(
      { userId: payload.userId, profileId: payload.profileId, symbol: payload.symbol, since },
      'pipeline_archive_grid_trade_nothing_to_archive',
    );
    return;
  }
  // A SELL with no cost basis (`realized_pnl IS NULL`) is excluded from profit,
  // so the row UNDER-counts rather than fabricating a zero-cost gain. Surface
  // the gap so the operator can rebuild the missing basis (myTrades backfill)
  // instead of trusting a silently-low number.
  if (summary.missingCostBasis > 0) {
    deps.logger.warn(
      {
        userId: payload.userId,
        profileId: payload.profileId,
        symbol: payload.symbol,
        missingCostBasis: summary.missingCostBasis,
      },
      'pipeline_archive_grid_trade_missing_cost_basis',
    );
  }
  const rows = await p.tradeArchive.listClosedSince(payload.symbol, since, archiveCutoff);
  // Archive every FILLED row's summary into the generic `orders` jsonb. The
  // strategy-specific split lives in `summary.breakdown` (grouped per
  // `intent:side` by the SQL aggregator), so no intent-aware partition is
  // needed here and any strategy's intents archive without code changes.
  const orderSummaries: OrderSummary[] = rows.map(summariseOrder);
  // Pull commissions for exactly these orders and prove the returned fills add up to the exchange totals captured on each local order.
  const { fees, feesQuote, feeBasis } = await resolveFees(
    deps,
    payload,
    orderSummaries,
    symbolInfo.baseAsset,
    symbolInfo.quoteAsset,
  );
  // Stamp the symbol's current provenance so the net-edge scoreboard isolates discovery-attributed realised PnL. Falls back to `unknown` when the binding was already removed (a late archive after an unsubscribe): the cycle really did happen and nobody can now say who chose the coin, so crediting the operator would put a trade discovery may well have made into the manual column.
  const source = (await p.profileSymbols.findForSymbol(payload.symbol))?.source ?? 'unknown';
  // Natural cross-pod dedup key: the cycle's max order close time. `rows` is
  // ordered `desc(closedAt)`, so `rows[0]` is the latest close; it is identical
  // for two consumers archiving the same completed cycle, so the partial unique
  // index collapses their inserts. Falls back to the cutoff on the (guarded-
  // unreachable) empty-rows case so the value is never null.
  const cycleEnd = rows[0]?.closedAt ?? archiveCutoff;
  const inserted = await p.tradeArchive.insert({
    symbol: payload.symbol,
    baseAsset: symbolInfo.baseAsset,
    quoteAsset: symbolInfo.quoteAsset,
    totalBuyQuote: summary.totalBuyQuote,
    totalSellQuote: summary.totalSellQuote,
    breakdown: summary.breakdown,
    profit: summary.profit,
    // Persist the gap, not just the warn above: once the row is written, an
    // under-counted `profit` of 0 is indistinguishable from a real break-even,
    // and only this count lets the API and UI say "unavailable" instead.
    missingCostBasis: summary.missingCostBasis,
    orders: orderSummaries,
    fees,
    feesQuote,
    feeBasis,
    source,
    // Pin `archivedAt` to the captured cutoff so the next archive's
    // `since` is consistent with the rows already accounted for here.
    // Without this, an order closing between the queries and the
    // insert would silently miss both archives.
    archivedAt: archiveCutoff,
    cycleEnd,
  });
  if (!inserted) {
    // A concurrent consumer already archived this exact cycle; the unique
    // index collapsed our insert. Not an error — no duplicate PnL row lands.
    deps.logger.info(
      { userId: payload.userId, profileId: payload.profileId, symbol: payload.symbol, cycleEnd },
      'pipeline_archive_grid_trade_already_archived',
    );
    return;
  }
  deps.logger.info(
    {
      userId: payload.userId,
      profileId: payload.profileId,
      symbol: payload.symbol,
      archiveId: inserted.id,
      orderCount: summary.orderCount,
      profit: summary.profit,
      feesQuote,
    },
    'pipeline_archive_grid_trade_ok',
  );
};
