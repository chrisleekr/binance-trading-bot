import type { Logger } from 'pino';
import { Decimal } from '@app/money';
import { profileRepo, type Database } from '@app/db';
import type { BinanceRestClient } from '@app/binance';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import { valueCommissionInQuote } from './archive-grid-trade.js';

// One pass reconciles at most this many archive rows. A profile accrues far fewer
// closed trades than this in practice; the cap bounds a single job's Binance reads.
const RECONCILE_BATCH = 500;

export interface ReconcileFeesHandlerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly resolveBinanceClient: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<BinanceRestClient | null>;
}

/** Parse the Binance order ids out of an archive row's `orders` jsonb array. */
const orderIdsOf = (orders: unknown): ReadonlySet<number> => {
  const ids = new Set<number>();
  if (!Array.isArray(orders)) return ids;
  for (const o of orders) {
    const raw = (o as { binanceOrderId?: unknown }).binanceOrderId;
    const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
    if (Number.isFinite(n)) ids.add(n);
  }
  return ids;
};

/**
 * Operator-triggered fee reconciliation: backfill `trade_archive.fees_quote` (and
 * the per-asset `fees` audit record) with real Binance commission for rows that
 * were never valued — rows archived before the fee column shipped, or whose
 * forward fee lookup degraded to zero. For each row it matches the symbol's
 * recent `myTrades` by the order ids stored in the row's `orders`, exactly as the
 * archive path does, and values commission via the SHARED {@link
 * valueCommissionInQuote} so the two paths cannot drift. Same `limit: 1000`
 * recent-page semantics as the archive path: a round-trip older than the last
 * 1000 trades for its symbol matches nothing and is left untouched (counted as
 * `unreconciled`), never overwritten with a spurious zero. Net-of-fee P/L reads
 * `fees_quote` directly, so corrected rows surface on the next dashboard read.
 */
export const handleReconcileFees = async (
  deps: ReconcileFeesHandlerDeps,
  ids: { userId: UserId; accountId: AccountId; profileId: ProfileId },
): Promise<void> => {
  const logCtx = { userId: ids.userId, profileId: ids.profileId };
  const p = await profileRepo(deps.db, ids.userId, ids.accountId, ids.profileId);
  const rows = await p.tradeArchive.listWithUnvaluedFees(RECONCILE_BATCH);
  if (rows.length === 0) {
    deps.logger.info(logCtx, 'pipeline_reconcile_fees_noop');
    return;
  }
  const client = await deps.resolveBinanceClient(ids.userId, ids.accountId);
  if (!client) {
    deps.logger.warn(logCtx, 'pipeline_reconcile_fees_unavailable');
    return;
  }

  // myTrades is per-symbol and config-independent within the run; fetch once per
  // symbol. The ticker price cache spans all rows (BNB→quote etc.).
  const tradesBySymbol = new Map<string, Awaited<ReturnType<BinanceRestClient['getMyTrades']>>>();
  const priceCache = new Map<string, Decimal | null>();
  let updated = 0;
  let unreconciled = 0;

  for (const row of rows) {
    const orderIds = orderIdsOf(row.orders);
    if (orderIds.size === 0) {
      unreconciled += 1;
      continue;
    }
    let trades = tradesBySymbol.get(row.symbol);
    if (!trades) {
      try {
        trades = await client.getMyTrades({ symbol: row.symbol, limit: 1000 });
      } catch (err) {
        deps.logger.warn(
          { ...logCtx, symbol: row.symbol, err },
          'pipeline_reconcile_fees_fetch_failed',
        );
        continue;
      }
      tradesBySymbol.set(row.symbol, trades);
    }

    const sums = new Map<string, Decimal>();
    let feesQuote = new Decimal(0);
    const matchedIds = new Set<number>();
    let unpriced = 0;
    for (const t of trades) {
      if (!orderIds.has(t.orderId)) continue;
      matchedIds.add(t.orderId);
      sums.set(
        t.commissionAsset,
        (sums.get(t.commissionAsset) ?? new Decimal(0)).add(new Decimal(t.commission)),
      );
      const quoteValue = await valueCommissionInQuote(
        client,
        t,
        row.baseAsset,
        row.quoteAsset,
        priceCache,
      );
      if (quoteValue === null) unpriced += 1;
      else feesQuote = feesQuote.add(quoteValue);
    }
    // No matching trade on the recent page (round-trip older than 1000 trades, or
    // a thin page): leave the row untouched rather than stamp a fabricated zero.
    if (matchedIds.size === 0) {
      unreconciled += 1;
      continue;
    }
    // Mirror the archive path's no-silent-failure guards: a row where only SOME
    // orders matched the page is a partial under-count, and a commission asset
    // that could not be priced into quote is left out of feesQuote — both warn
    // (with counts) so the under-count is visible, never silent.
    if (matchedIds.size < orderIds.size) {
      deps.logger.warn(
        { ...logCtx, archiveId: row.id, matched: matchedIds.size, expected: orderIds.size },
        'pipeline_reconcile_fees_partial',
      );
    }
    if (unpriced > 0) {
      deps.logger.warn(
        { ...logCtx, archiveId: row.id, unpricedTrades: unpriced },
        'pipeline_reconcile_fees_unpriced',
      );
    }
    const fees: Record<string, string> = {};
    for (const [asset, total] of sums) fees[asset] = total.toString();
    await p.tradeArchive.updateFees(row.id, fees, feesQuote.toString());
    updated += 1;
  }

  deps.logger.info(
    { ...logCtx, scanned: rows.length, updated, unreconciled },
    'pipeline_reconcile_fees_done',
  );
};
