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
import type { AccountId, ProfileId, UserId } from '@app/contracts';
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
  readonly side: string;
  readonly status: string;
  readonly meta: Record<string, unknown> | null;
  readonly closedAt: string | null;
  readonly raw: unknown;
}

const summariseOrder = (row: {
  readonly id: string;
  readonly binanceOrderId: bigint;
  readonly clientOrderId: string;
  readonly intent: string;
  readonly side: string;
  readonly status: string;
  readonly meta: unknown;
  readonly closedAt: Date | null;
  readonly raw: unknown;
}): OrderSummary => ({
  orderId: row.id,
  // bigint → decimal string so JSON serialisation is lossless. The
  // archive column is jsonb, so reading code can re-parse as bigint if
  // needed; reading code is the SPA which only renders the value.
  binanceOrderId: row.binanceOrderId.toString(),
  clientOrderId: row.clientOrderId,
  intent: row.intent,
  side: row.side,
  status: row.status,
  // Strategy-owned order metadata, opaque here (TT: `{ gridTradeIndex }`).
  meta: (row.meta as Record<string, unknown> | null) ?? null,
  closedAt: row.closedAt?.toISOString() ?? null,
  raw: row.raw,
});

/**
 * Load `SymbolInfo` from the Redis snapshot. The exchange-info-refresh
 * cron writes the same shape used at tick time, so the archive picks up
 * `baseAsset` / `quoteAsset` without an extra Binance call. Returns
 * null on absent key OR malformed JSON; the caller distinguishes the
 * two via the warn log emitted here so a "cache cold" outcome and a
 * "cache corrupted" outcome are not conflated in the operator
 * dashboard.
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

/** Raw per-asset commissions plus their quote-valued total for net-of-fee P/L. */
interface ResolvedFees {
  /** Per commission asset, total paid as a decimal string (audit record). */
  readonly fees: Record<string, string>;
  /**
   * The same commissions valued in the quote asset, as a decimal string. A
   * commission asset that can be neither matched to the quote/base asset nor
   * priced via a ticker lookup is recorded in `fees` but EXCLUDED here (logged),
   * so this is a conservative under-count rather than a fabricated value.
   */
  readonly feesQuote: string;
}

/**
 * Value one commission in the quote asset. `quote` 1:1; `base` at the fill
 * price; anything else (e.g. BNB) at a `{asset}{quote}` ticker, cached per
 * archive call. Returns null when the asset cannot be priced so the caller can
 * record the raw fee but leave it out of the quote total instead of guessing.
 */
export const valueCommissionInQuote = async (
  client: BinanceRestClient,
  trade: { commission: string; commissionAsset: string; price: string },
  baseAsset: string,
  quoteAsset: string,
  priceCache: Map<string, Decimal | null>,
): Promise<Decimal | null> => {
  const commission = new Decimal(trade.commission);
  if (commission.isZero()) return new Decimal(0);
  if (trade.commissionAsset === quoteAsset) return commission;
  if (trade.commissionAsset === baseAsset) return commission.mul(new Decimal(trade.price));
  const pair = `${trade.commissionAsset}${quoteAsset}`;
  let price = priceCache.get(pair);
  if (price === undefined) {
    try {
      price = new Decimal((await client.getTicker24hr(pair)).lastPrice);
    } catch {
      price = null;
    }
    priceCache.set(pair, price);
  }
  return price === null ? null : commission.mul(price);
};

/**
 * Sum the Binance commissions for the archived orders, both per commission asset
 * (audit) and valued in the quote asset (net-of-fee P/L). Pulls `myTrades` for
 * the symbol and keeps only trades whose `orderId` is in the archived set, so a
 * residual older-cycle trade in the same page is not double-counted. Degrades to
 * empty (logged at warn) when the client is unavailable, the call throws, OR a
 * commission string fails to parse — fees are a nicety, not a reason to fail an
 * otherwise-correct archive. When some archived orders matched zero returned
 * trades (a truncated page) the sums are a partial under-count: still returned,
 * but a distinct warn flags the gap so it is never silent. A commission asset
 * that cannot be priced into the quote (no direct ticker) is kept in `fees` but
 * left out of `feesQuote`, with its own warn.
 */
export const resolveFees = async (
  deps: ArchiveGridTradeHandlerDeps,
  payload: ArchiveGridTradeJobPayload,
  binanceOrderIds: ReadonlySet<number>,
  baseAsset: string,
  quoteAsset: string,
): Promise<ResolvedFees> => {
  const empty: ResolvedFees = { fees: {}, feesQuote: '0' };
  if (binanceOrderIds.size === 0) return empty;
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
    const sums = new Map<string, Decimal>();
    const priceCache = new Map<string, Decimal | null>();
    let feesQuote = new Decimal(0);
    let unpriced = 0;
    // Each archived order is a FILLED order, so it should match >=1 returned
    // trade. Track which archived orderIds we actually saw so a truncated page
    // (some orderIds absent) surfaces as a partial under-count, not silence.
    const matched = new Set<number>();
    for (const t of trades) {
      if (!binanceOrderIds.has(t.orderId)) continue;
      matched.add(t.orderId);
      const prior = sums.get(t.commissionAsset) ?? new Decimal(0);
      sums.set(t.commissionAsset, prior.add(new Decimal(t.commission)));
      const quoteValue = await valueCommissionInQuote(client, t, baseAsset, quoteAsset, priceCache);
      if (quoteValue === null) unpriced += 1;
      else feesQuote = feesQuote.add(quoteValue);
    }
    const missing = [...binanceOrderIds].filter((id) => !matched.has(id));
    if (missing.length > 0) {
      deps.logger.warn(
        { ...logCtx, missingOrderIds: missing.length },
        'pipeline_archive_grid_trade_fees_partial',
      );
    }
    if (unpriced > 0) {
      deps.logger.warn(
        { ...logCtx, unpricedTrades: unpriced },
        'pipeline_archive_grid_trade_fees_quote_unpriced',
      );
    }
    const fees: Record<string, string> = {};
    for (const [asset, total] of sums) fees[asset] = total.toString();
    return { fees, feesQuote: feesQuote.toString() };
  } catch (err) {
    deps.logger.warn({ ...logCtx, err }, 'pipeline_archive_grid_trade_fees_unavailable');
    return empty;
  }
};

export const handleArchiveGridTrade = async (
  deps: ArchiveGridTradeHandlerDeps,
  payload: ArchiveGridTradeJobPayload,
): Promise<void> => {
  // Symbol filters differ per Binance mode; read the keyspace matching this
  // profile's mode so a test-mode profile archives against testnet filters, not
  // production (#582). A missing profile (deletion race) fails closed to test.
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
  // Pull per-asset Binance commissions for exactly the archived orders. The
  // set is the Binance order ids of the FILLED rows in this cycle so a stray
  // older trade in the same `myTrades` page is not summed.
  const binanceOrderIds = new Set(rows.map((r) => Number(r.binanceOrderId)));
  const { fees, feesQuote } = await resolveFees(
    deps,
    payload,
    binanceOrderIds,
    symbolInfo.baseAsset,
    symbolInfo.quoteAsset,
  );
  // Stamp the symbol's current source (manual vs discovery-auto) so the
  // net-edge scoreboard isolates discovery-attributed realised PnL. Falls
  // back to `manual` when the binding was already removed (e.g. a late
  // archive after an unsubscribe).
  const source = (await p.profileSymbols.findForSymbol(payload.symbol))?.source ?? 'manual';
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
    profitPercent: summary.profitPercent,
    orders: orderSummaries,
    fees,
    feesQuote,
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
      profitPercent: summary.profitPercent,
      feesQuote,
    },
    'pipeline_archive_grid_trade_ok',
  );
};
