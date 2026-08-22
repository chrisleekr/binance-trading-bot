// Pipeline `backfill-trade-archive` handler. A one-off, operator-triggered
// recovery: reconstructs completed round-trips for `(profile, symbol)` from
// Binance `myTrades` and inserts the missing `trade_archive` rows so the
// discovery scoreboard and trade-archive page reflect realised P/L that
// predates the forward archive (which only records cycles going forward and
// reads the local `orders` table, where the historic BUY rows are missing).
//
// Profile attribution is the operator's explicit `(profile, symbol)` choice: every fill on that symbol/account is credited to the chosen profile because myTrades cannot distinguish two profiles sharing that market. Exit-reason attribution is stricter: only one exact local terminal SELL can replace the synthetic closing order's `backfill` intent.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { BinanceMode, BinanceRestClient, MyTradeDto } from '@app/binance';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import type { Database, RecoveryAttributionRow } from '@app/db';
import { profileRepo, repo } from '@app/db';
import { Decimal, isPlainDecimalString } from '@app/money';

import { buildSymbolInfoKey } from 'executor/redis-namespace.js';
import { loadSymbolInfo } from 'queues/pipeline-handlers/archive-grid-trade.js';
import {
  reconstructRoundTrips,
  type ReconstructedOrderSummary,
  type ReconstructedRoundTrip,
} from 'queues/pipeline-handlers/reconstruct-round-trips.js';

export interface BackfillTradeArchiveJobPayload {
  readonly userId: UserId;
  readonly accountId: AccountId;
  readonly profileId: ProfileId;
  readonly symbol: string;
  // Inclusive window (epoch ms) on a round-trip's closing-fill time, or null
  // for unbounded. Lets the operator scope to the pre-forward-archive period.
  readonly fromMs: number | null;
  readonly toMs: number | null;
}

export interface BackfillTradeArchiveHandlerDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly resolveBinanceClient: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<BinanceRestClient | null>;
}

// Binance's max page; myTrades returns oldest-first and `fromId` bounds the
// query to trade ids >= fromId, so paginating from 0 walks the full history.
const PAGE = 1000;

/** Why one cycle's closing exit stayed `backfill`, or `attributed` when it did not. Counted per run so a recovery that restores nothing says WHICH proof failed instead of going quiet. */
type AttributionOutcome =
  | 'attributed'
  | 'no-closing-summary'
  | 'no-candidate'
  | 'ambiguous-identity'
  | 'not-terminal-sell'
  | 'blank-intent'
  | 'quantity-unproven';

/**
 * Checks that two order quantities are positive decimals with the same numeric value.
 *
 * Only `local` gets the plain-string guard: it is DB-stored wire input, whereas `reconstructed` is a `Decimal` this codebase just summed and rendered, and `Decimal.prototype.toString` emits exponential notation at or below `toExpNeg` (default -7). Guarding it too refused a legitimate `1e-7` closing quantity.
 *
 * @param local - Executed quantity stored on the local order.
 * @param reconstructed - Quantity summed from Binance trade fills.
 * @returns True only when both quantities are positive and Decimal-equal.
 */
const samePositiveQuantity = (local: string, reconstructed: string): boolean => {
  if (!isPlainDecimalString(local)) return false;
  const localQuantity = new Decimal(local);
  const reconstructedQuantity = new Decimal(reconstructed);
  return (
    localQuantity.gt(0) && reconstructedQuantity.gt(0) && localQuantity.eq(reconstructedQuantity)
  );
};

/**
 * Restores the closing SELL intent only when one local order proves its identity and quantity.
 *
 * @param roundTrip - Reconstructed cycle whose synthetic orders default to the backfill intent.
 * @param candidatesById - Profile-scoped identity rows for the recovery batch, bucketed by decimal-string order id so each cycle is a lookup rather than a rescan of the whole batch.
 * @returns The summaries to archive, and why the closing exit was or was not attributed.
 */
const attributeRecoveredClosingExit = (
  roundTrip: ReconstructedRoundTrip,
  candidatesById: ReadonlyMap<string, readonly RecoveryAttributionRow[]>,
): { readonly orders: ReconstructedOrderSummary[]; readonly outcome: AttributionOutcome } => {
  const closingOrder = roundTrip.orders.find(
    (order) => order.side === 'SELL' && order.binanceOrderId === roundTrip.closingBinanceOrderId,
  );
  if (closingOrder === undefined) {
    // Unreachable while `buildRoundTrip` holds: it emits one summary per order id in the cycle and takes `closingBinanceOrderId` from the closing fill, which is always the SELL that flattened the position. Kept, but under its own name: folding it into `no-candidate` would report a broken reconstruction invariant as the benign "history predates the local rows" case, which is the one distinction this tally exists to make.
    return { orders: roundTrip.orders, outcome: 'no-closing-summary' };
  }

  const [candidate, ...rest] = candidatesById.get(roundTrip.closingBinanceOrderId) ?? [];
  if (candidate === undefined) {
    return { orders: roundTrip.orders, outcome: 'no-candidate' };
  }
  if (rest.length > 0) {
    return { orders: roundTrip.orders, outcome: 'ambiguous-identity' };
  }
  if (candidate.side !== 'SELL' || candidate.status !== 'FILLED' || candidate.closedAt === null) {
    return { orders: roundTrip.orders, outcome: 'not-terminal-sell' };
  }
  if (candidate.intent.trim().length === 0) {
    return { orders: roundTrip.orders, outcome: 'blank-intent' };
  }
  if (
    candidate.executedQty === null ||
    !samePositiveQuantity(candidate.executedQty, closingOrder.qty)
  ) {
    return { orders: roundTrip.orders, outcome: 'quantity-unproven' };
  }

  return {
    orders: roundTrip.orders.map((order) =>
      order === closingOrder ? { ...order, intent: candidate.intent } : order,
    ),
    outcome: 'attributed',
  };
};

/**
 * Whether the mode's symbol-info keyspace holds anything at all.
 *
 * This is the discriminator between "the cache is cold" and "Binance does not
 * list this symbol any more", and it is the cheapest one that is actually
 * decisive: `exchange-info-refresh` writes one key per listed symbol and
 * DELETES the keys of symbols that dropped off `exchangeInfo`, so a populated
 * keyspace missing this symbol is positive evidence the symbol is gone, while
 * an empty keyspace only means the cron has not run since boot. The alternative
 * — a REST `exchangeInfo` probe — would answer the same question at an
 * account-wide weight cost on a path the recovery sweep runs every 15 minutes.
 */
const symbolInfoKeyspacePrimed = async (redis: Redis, mode: BinanceMode): Promise<boolean> => {
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(
      cursor,
      'MATCH',
      buildSymbolInfoKey('*', mode),
      'COUNT',
      500,
    );
    cursor = next;
    if (batch.length > 0) return true;
  } while (cursor !== '0');
  return false;
};

const fetchAllMyTrades = async (
  client: BinanceRestClient,
  symbol: string,
): Promise<MyTradeDto[]> => {
  const all: MyTradeDto[] = [];
  let fromId = 0;
  for (;;) {
    const page = await client.getMyTrades({ symbol, fromId, limit: PAGE });
    all.push(...page);
    if (page.length < PAGE) break;
    const last = page[page.length - 1];
    if (!last) break;
    fromId = last.id + 1;
  }
  return all;
};

export const handleBackfillTradeArchive = async (
  deps: BackfillTradeArchiveHandlerDeps,
  payload: BackfillTradeArchiveJobPayload,
): Promise<void> => {
  const logCtx = { userId: payload.userId, profileId: payload.profileId, symbol: payload.symbol };
  const client = await deps.resolveBinanceClient(payload.userId, payload.accountId);
  if (!client) {
    // No profile or API key: nothing to fetch and a retry won't conjure one.
    deps.logger.warn(logCtx, 'pipeline_backfill_trade_archive_no_client');
    return;
  }
  // Created up-front so every completion path can stamp the attempt marker —
  // the marker is what moves a coin out of the "recover" nudge and into the
  // quiet "no recoverable history" note instead of nagging forever.
  const p = await profileRepo(deps.db, payload.userId, payload.accountId, payload.profileId);
  // Symbol filters differ per Binance mode; read the keyspace matching this
  // account's mode so a test-mode account reads testnet filters (#582). A
  // missing account (deletion race) fails closed to test.
  const mode: BinanceMode =
    (await repo.accounts.binanceModeById(deps.db, payload.accountId)) === 'live' ? 'live' : 'test';
  // baseAsset/quoteAsset are NOT NULL columns; the Redis snapshot is the same
  // source the forward archive uses.
  const symbolInfo = await loadSymbolInfo(deps.redis, payload.symbol, mode, deps.logger);
  if (!symbolInfo) {
    // `loadSymbolInfo` returns null for an ABSENT key and for a corrupt value
    // alike, and only the first is evidence of delisting. Probing the key
    // separates them: stamping the terminating marker on a corrupt value would
    // strand the symbol permanently, because a marker only re-opens when a
    // LATER fill makes it stale and the next exchange-info refresh repairs the
    // value without anything re-reading it.
    const keyPresent = (await deps.redis.exists(buildSymbolInfoKey(payload.symbol, mode))) > 0;
    if (!keyPresent && (await symbolInfoKeyspacePrimed(deps.redis, mode))) {
      // Binance no longer lists this symbol, so no retry will ever resolve it.
      // Terminate on a marker instead of throwing: the recovery sweep re-enqueues
      // every recoverable symbol on a fresh jobId every 15 minutes, so a throw
      // here is a permanent retry-then-dead-letter loop that alerts the operator
      // forever about a coin nothing can fix.
      await p.tradeArchive.recordBackfillAttempt({
        symbol: payload.symbol,
        roundTrips: 0,
        skippedOrphanSells: 0,
        droppedOvershoot: 0,
        symbolUnavailable: true,
      });
      deps.logger.warn(logCtx, 'pipeline_backfill_trade_archive_symbol_unlisted');
      return;
    }
    // Cold cache, or a key present but unparsable: both are repaired by the
    // next exchange-info refresh, so retry rather than guessing the assets from
    // the symbol string or writing a marker nothing will ever revisit.
    deps.logger.warn(
      { ...logCtx, keyPresent },
      'pipeline_backfill_trade_archive_symbol_info_missing',
    );
    throw new Error(
      `pipeline_backfill_trade_archive: symbol-info missing for ${payload.symbol} (${keyPresent ? 'cached value unreadable' : 'refresh cron not yet primed'})`,
    );
  }

  // Read BEFORE the fetch: the marker has to claim only the history this pass
  // actually saw. Walking `myTrades` takes a page round-trip per 1000 fills, and
  // a fill the adopter records during that walk is absent from `fills` yet would
  // sort before a write-time marker, so the symbol would read as recovered and
  // never be swept again.
  const attemptedAt = await p.tradeArchive.attemptBoundary();
  const fills = await fetchAllMyTrades(client, payload.symbol);
  if (fills.length === 0) {
    await p.tradeArchive.recordBackfillAttempt({
      symbol: payload.symbol,
      roundTrips: 0,
      skippedOrphanSells: 0,
      droppedOvershoot: 0,
      attemptedAt,
    });
    deps.logger.info(logCtx, 'pipeline_backfill_trade_archive_no_trades');
    return;
  }

  const { roundTrips, skippedOrphanSells, droppedOvershootCycles } = reconstructRoundTrips(fills);
  if (skippedOrphanSells > 0 || droppedOvershootCycles > 0) {
    // Un-costed base (orphan sells while flat, or a cycle that sold more than
    // it bought): dropped because no honest P/L exists. Surfaced, never silent.
    deps.logger.warn(
      { ...logCtx, skippedOrphanSells, droppedOvershootCycles },
      'pipeline_backfill_trade_archive_uncosted_base',
    );
  }
  const inWindow = roundTrips.filter(
    (rt) =>
      (payload.fromMs === null || rt.closedAtMs >= payload.fromMs) &&
      (payload.toMs === null || rt.closedAtMs <= payload.toMs),
  );
  if (inWindow.length === 0) {
    await p.tradeArchive.recordBackfillAttempt({
      symbol: payload.symbol,
      roundTrips: 0,
      skippedOrphanSells,
      droppedOvershoot: droppedOvershootCycles,
      attemptedAt,
    });
    deps.logger.info(
      { ...logCtx, reconstructed: roundTrips.length },
      'pipeline_backfill_trade_archive_nothing_in_window',
    );
    return;
  }

  // Idempotency: a re-run reconstructs identical round-trips with identical
  // closing trade ids. Collect every trade id already stamped into this
  // symbol's backfilled rows and skip any round-trip whose closing fill is
  // present. The limit covers a one-off recovery comfortably.
  //
  // The Binance ORDER ids are collected alongside because only backfilled rows
  // carry `tradeIds` — the forward archive summarises the local `orders` table,
  // which has no Binance trade ids. Now that the recoverable set is cycle-
  // relative, a symbol with live-archived history can legitimately be swept
  // again, and the trade-id marker alone would not see those cycles: every one
  // of them would be re-inserted as a duplicate P/L row under a different
  // `cycle_end`. The exchange order id is the key both row shapes share.
  //
  // Matched against the CLOSING order only. A BUY order whose partial fills
  // straddle a flat-out appears in two cycles, so matching any shared order
  // would discard the second real cycle as a duplicate.
  const existing = await p.tradeArchive.listForSymbol(payload.symbol, 10_000);
  const seenTradeIds = new Set<number>();
  const seenBinanceOrderIds = new Set<string>();
  for (const row of existing) {
    for (const order of (row.orders as { tradeIds?: number[]; binanceOrderId?: string }[] | null) ??
      []) {
      for (const tid of order.tradeIds ?? []) seenTradeIds.add(tid);
      if (order.binanceOrderId !== undefined) seenBinanceOrderIds.add(String(order.binanceOrderId));
    }
  }

  const missing = inWindow.filter(
    (roundTrip) =>
      !seenTradeIds.has(roundTrip.closingTradeId) &&
      !seenBinanceOrderIds.has(roundTrip.closingBinanceOrderId),
  );
  // `BigInt()` throws on anything that is not an integer literal, and `orderId` reaches here from an unvalidated `myTrades` response, so a malformed id is dropped instead of killing a job that has already walked the whole history. A dropped id simply finds no local row, which is the same fail-closed outcome as a failed proof.
  const closingOrderIds = [...new Set(missing.map((roundTrip) => roundTrip.closingBinanceOrderId))]
    .filter((orderId) => /^\d+$/.test(orderId))
    .map((orderId) => BigInt(orderId));
  const localExitCandidates = await p.orders.listRecoveryAttributionRows(
    payload.symbol,
    closingOrderIds,
  );
  // Bucket once. Rescanning the batch per cycle is O(cycles x candidates) with a `toString()` per comparison, and both sides scale with the symbol's whole history.
  const candidatesById = new Map<string, RecoveryAttributionRow[]>();
  for (const candidate of localExitCandidates) {
    const key = candidate.binanceOrderId.toString();
    const bucket = candidatesById.get(key);
    if (bucket) bucket.push(candidate);
    else candidatesById.set(key, [candidate]);
  }

  let inserted = 0;
  const attribution: Record<AttributionOutcome, number> = {
    attributed: 0,
    'no-closing-summary': 0,
    'no-candidate': 0,
    'ambiguous-identity': 0,
    'not-terminal-sell': 0,
    'blank-intent': 0,
    'quantity-unproven': 0,
  };
  for (const rt of missing) {
    const { orders: attributedOrders, outcome } = attributeRecoveredClosingExit(rt, candidatesById);
    attribution[outcome] += 1;
    const row = await p.tradeArchive.insert({
      symbol: payload.symbol,
      baseAsset: symbolInfo.baseAsset,
      quoteAsset: symbolInfo.quoteAsset,
      totalBuyQuote: rt.totalBuyQuote,
      totalSellQuote: rt.totalSellQuote,
      breakdown: rt.breakdown,
      profit: rt.profit,
      profitPercent: rt.profitPercent,
      orders: attributedOrders,
      fees: rt.fees,
      // Backfilled cycles are reconstructed from discovery-era trade history;
      // the discovery scoreboard reads source='auto', so stamp it.
      source: 'auto',
      // Pin to the real closing time so historic P/L lands at its trade date
      // and these past rows never disturb the forward archive's `since`
      // cutoff (which tracks the latest archivedAt).
      archivedAt: new Date(rt.closedAtMs),
      // The round-trip's closing time is the natural cycle key: a concurrent
      // backfill of the same round-trip collapses on the partial unique index.
      cycleEnd: new Date(rt.closedAtMs),
    });
    // `null` = a concurrent consumer already archived this cycle; don't count it.
    if (row) inserted += 1;
  }
  // CUMULATIVE, not this pass's insert count. `round_trips = 0` is the sole
  // discriminator `listUnreconstructableSymbols` uses between "nothing could be
  // recovered" and "already recovered", and a re-sweep of an already-recovered
  // symbol inserts 0 BY DESIGN (every cycle dedupes). Recording that 0 would
  // make the coin claim it has no reconstructable history while its cycles sit
  // archived, and re-walk its whole `myTrades` on every later staleness.
  await p.tradeArchive.recordBackfillAttempt({
    symbol: payload.symbol,
    roundTrips: inserted + existing.length,
    skippedOrphanSells,
    droppedOvershoot: droppedOvershootCycles,
    attemptedAt,
  });
  // Two local rows claiming one exchange order id is a data-integrity anomaly, not a normal miss: a Binance orderId is an exact identity for an order on the account's book, so a duplicate means one of the rows is wrong. Surfaced rather than folded into the silent tally.
  if (attribution['ambiguous-identity'] > 0) {
    deps.logger.warn(
      { ...logCtx, ambiguousIdentities: attribution['ambiguous-identity'] },
      'pipeline_backfill_trade_archive_ambiguous_exit_identity',
    );
  }
  deps.logger.info(
    {
      ...logCtx,
      inserted,
      candidates: inWindow.length,
      reconstructed: roundTrips.length,
      // Without these an operator cannot tell "no local row survived the era" from "the rows were there and failed the proof", which is the difference between expected data loss and a bug.
      exitsAttributed: attribution.attributed,
      exitsUnattributed: {
        noClosingSummary: attribution['no-closing-summary'],
        noCandidate: attribution['no-candidate'],
        ambiguousIdentity: attribution['ambiguous-identity'],
        notTerminalSell: attribution['not-terminal-sell'],
        blankIntent: attribution['blank-intent'],
        quantityUnproven: attribution['quantity-unproven'],
      },
    },
    'pipeline_backfill_trade_archive_ok',
  );
};
