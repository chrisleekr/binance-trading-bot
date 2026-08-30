import type { Logger } from 'pino';
import { profileRepo, type Database } from '@app/db';
import type { BinanceRestClient } from '@app/binance';
import type { AccountId, ProfileId, UserId } from '@app/contracts';
import {
  createCommissionRateResolver,
  resolveFeesFromTradesWithRates,
  type FeeOrderEvidence,
} from './archive-grid-trade.js';

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

/**
 * Parse the order identity, fill totals, side, and application-owned BUY fee proof out of archived JSON without trusting malformed members.
 *
 * @param orders - Legacy-compatible archive JSON, which may not be an array or may contain malformed members.
 * @returns Conservative order evidence that can be matched against Binance account trades.
 */
const feeOrdersOf = (orders: unknown): FeeOrderEvidence[] => {
  if (!Array.isArray(orders)) return [];
  return orders.map((candidate) => {
    const order =
      typeof candidate === 'object' && candidate !== null
        ? (candidate as Record<string, unknown>)
        : {};
    const raw =
      typeof order['raw'] === 'object' && order['raw'] !== null
        ? (order['raw'] as Record<string, unknown>)
        : {};
    const binanceOrderId = order['binanceOrderId'];
    const side = order['side'];
    const executedQty = order['executedQty'] ?? order['qty'] ?? raw['executedQty'];
    const cummulativeQuoteQty = order['cummulativeQuoteQty'] ?? raw['cummulativeQuoteQty'];
    return {
      binanceOrderId:
        typeof binanceOrderId === 'string' || typeof binanceOrderId === 'number'
          ? String(binanceOrderId)
          : '',
      side: side === 'BUY' || side === 'SELL' ? side : null,
      executedQty: typeof executedQty === 'string' ? executedQty : null,
      cummulativeQuoteQty: typeof cummulativeQuoteQty === 'string' ? cummulativeQuoteQty : null,
      baseCommissionNetted:
        typeof order['baseCommissionNetted'] === 'string' ? order['baseCommissionNetted'] : null,
    };
  });
};

/**
 * Reconcile rows marked explicitly incomplete by applying the same raw-fee, quote-adjustment, and evidence rule as forward archive and backfill. Missing or partial fill evidence leaves the row untouched because replacing an existing subtotal with another partial set could lose previously known fees. A fully covered row can still update as incomplete when a third-asset amount has no execution-time quote rate.
 *
 * @param deps - Reconciliation dependencies for the scoped repository, Binance client, and logs.
 * @param ids - Ownership-proven identifiers for the one profile being reconciled.
 * @returns Nothing after the bounded reconciliation pass is logged.
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

  // myTrades is per-symbol and config-independent within the run; fetch once per symbol.
  const tradesBySymbol = new Map<string, Awaited<ReturnType<BinanceRestClient['getMyTrades']>>>();
  // One resolver for the whole pass, mirroring the myTrades memo beside it: the rates cannot change inside one job, and a batch of 500 rows would otherwise spend a weight-20 call per row on the same symbol.
  const resolveCommissionRates = createCommissionRateResolver(client, deps.logger);
  let updated = 0;
  let unreconciled = 0;

  for (const row of rows) {
    const expectedOrders = feeOrdersOf(row.orders);
    if (expectedOrders.length === 0) {
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

    const resolved = await resolveFeesFromTradesWithRates(
      trades,
      expectedOrders,
      row.symbol,
      row.baseAsset,
      row.quoteAsset,
      resolveCommissionRates,
    );
    // No matching trade on the recent page leaves the row untouched rather than stamping a fabricated zero.
    if (resolved.matchedOrderIds === 0) {
      unreconciled += 1;
      continue;
    }
    // Mirror the archive path's no-silent-failure guards before deciding whether this evidence can safely replace the stored row.
    if (resolved.missingOrderIds > 0) {
      deps.logger.warn(
        {
          ...logCtx,
          archiveId: row.id,
          matched: resolved.matchedOrderIds,
          expected: expectedOrders.length,
        },
        'pipeline_reconcile_fees_partial',
      );
    }
    if (resolved.mismatchedOrders > 0 || resolved.malformedOrders > 0) {
      deps.logger.warn(
        {
          ...logCtx,
          archiveId: row.id,
          mismatchedOrders: resolved.mismatchedOrders,
          malformedOrders: resolved.malformedOrders,
        },
        'pipeline_reconcile_fees_order_evidence_incomplete',
      );
    }
    if (resolved.unpricedTrades > 0) {
      deps.logger.warn(
        { ...logCtx, archiveId: row.id, unpricedTrades: resolved.unpricedTrades },
        'pipeline_reconcile_fees_unpriced',
      );
    }
    if (resolved.unprovenBaseBuyOrders > 0) {
      deps.logger.warn(
        { ...logCtx, archiveId: row.id, unprovenBaseBuyOrders: resolved.unprovenBaseBuyOrders },
        'pipeline_reconcile_fees_base_buy_unproven',
      );
    }
    if (resolved.malformedTrades > 0) {
      deps.logger.warn(
        { ...logCtx, archiveId: row.id, malformedTrades: resolved.malformedTrades },
        'pipeline_reconcile_fees_malformed',
      );
    }
    if (
      resolved.missingOrderIds > 0 ||
      resolved.mismatchedOrders > 0 ||
      resolved.malformedOrders > 0 ||
      resolved.malformedTrades > 0
    ) {
      unreconciled += 1;
      continue;
    }
    await p.tradeArchive.updateFees(row.id, resolved.fees, resolved.feesQuote, resolved.feeBasis);
    updated += 1;
  }

  deps.logger.info(
    { ...logCtx, scanned: rows.length, updated, unreconciled },
    'pipeline_reconcile_fees_done',
  );
};
