// Pure round-trip reconstruction from Binance `myTrades` fills, for the `backfill-trade-archive` handler. The forward archive aggregates the local `orders` table, but historic BUY rows can be ghost-missing, so the backfill rebuilds realised P/L purely from trade history. Synthetic intents default to `backfill`; the I/O-owning handler may restore only a proven local closing SELL intent. No I/O, no clock: a fills array in, reconstructed round-trips out.

import { Decimal } from '@app/money';
import type { MyTradeDto } from '@app/binance';

/**
 * One reconstructed order grouped from the fills of one Binance `orderId`. The archive keeps it as audit evidence and uses `tradeIds` as the backfill idempotency marker. `clientOrderId` and `raw` are null because `myTrades` does not return them and the ghost orders have no local row.
 */
export interface ReconstructedOrderSummary {
  readonly orderId: string;
  readonly binanceOrderId: string;
  readonly clientOrderId: null;
  readonly intent: string;
  readonly side: 'BUY' | 'SELL';
  readonly status: 'FILLED';
  readonly executedQty: string;
  readonly cummulativeQuoteQty: string;
  readonly baseCommissionNetted: string | null;
  readonly tradeIds: number[];
  readonly closedAt: string;
  readonly raw: null;
}

/**
 * A completed buy-then-emptied cycle. Quote totals and `profit` use the archive's Recorded basis; the I/O-owning handler resolves raw fees, the additional adjustment, and completeness separately. `breakdown` uses `backfill:BUY` and `backfill:SELL` because strategy intent is not recoverable from trade history. `closingTradeId` is the idempotency marker, and `closedAtMs` places historic P/L at the closing fill's time.
 */
export interface ReconstructedRoundTrip {
  readonly closingTradeId: number;
  /** Binance order id of the fill that flattened the cycle. The re-run guard keys on this rather than any order in the cycle because BUY partial fills can straddle a flat-out and legitimately belong to two cycles. */
  readonly closingBinanceOrderId: string;
  readonly closedAtMs: number;
  readonly totalBuyQuote: string;
  readonly totalSellQuote: string;
  readonly profit: string;
  readonly breakdown: Record<string, string>;
  readonly orders: ReconstructedOrderSummary[];
}

const BACKFILL_BUY = 'backfill:BUY';
const BACKFILL_SELL = 'backfill:SELL';

/**
 * Return the positive BUY commission that reduced received base quantity. Invalid commission text stays unproven here and is rejected by the shared fee resolver before completeness can become true.
 *
 * @param fill - Binance trade used by the reconstruction walk.
 * @param baseAsset - Symbol base asset whose BUY commission reduces wallet quantity.
 * @returns A positive base commission, or zero when none is proven.
 */
const buyBaseCommission = (fill: MyTradeDto, baseAsset: string): Decimal => {
  if (!fill.isBuyer || fill.commissionAsset !== baseAsset) return new Decimal(0);
  try {
    const commission = new Decimal(fill.commission);
    return commission.isFinite() && commission.gt(0) ? commission : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};

/**
 * Build one closed cycle's Recorded cashflow and synthetic order evidence. A BUY receives base-fee proof only when the cycle's exact net base quantity returned to zero.
 *
 * @param fills - Ordered fills belonging to one completed cycle.
 * @param baseAsset - Symbol base asset used to identify quantity-reducing BUY fees.
 * @returns The archive-ready cycle summary and idempotency markers.
 */
const buildRoundTrip = (
  fills: readonly MyTradeDto[],
  baseAsset: string,
): ReconstructedRoundTrip => {
  let totalBuyQuote = new Decimal(0);
  let totalSellQuote = new Decimal(0);
  let netBaseQuantity = new Decimal(0);
  // Group fills into one synthetic order per Binance orderId (a single order
  // fills as one or more trades). All fills of an order share a side.
  const byOrder = new Map<number, MyTradeDto[]>();
  for (const f of fills) {
    const quote = new Decimal(f.quoteQty);
    const qty = new Decimal(f.qty);
    if (f.isBuyer) {
      totalBuyQuote = totalBuyQuote.add(quote);
      netBaseQuantity = netBaseQuantity.add(qty.sub(buyBaseCommission(f, baseAsset)));
    } else {
      totalSellQuote = totalSellQuote.add(quote);
      netBaseQuantity = netBaseQuantity.sub(qty);
    }
    const group = byOrder.get(f.orderId);
    if (group) group.push(f);
    else byOrder.set(f.orderId, [f]);
  }
  const orders: ReconstructedOrderSummary[] = [...byOrder.entries()].map(([orderId, group]) => {
    const executedQty = group.reduce((sum, f) => sum.add(f.qty), new Decimal(0));
    const quoteQty = group.reduce((sum, f) => sum.add(f.quoteQty), new Decimal(0));
    const baseCommission = group.reduce(
      (sum, fill) => sum.add(buyBaseCommission(fill, baseAsset)),
      new Decimal(0),
    );
    const closedAtMs = group.reduce((m, f) => Math.max(m, f.time), 0);
    return {
      orderId: String(orderId),
      binanceOrderId: String(orderId),
      clientOrderId: null,
      intent: 'backfill',
      side: group[0]?.isBuyer ? 'BUY' : 'SELL',
      status: 'FILLED',
      executedQty: executedQty.toString(),
      cummulativeQuoteQty: quoteQty.toString(),
      // Exact net-base closure proves the lower SELL proceeds already carry this BUY base fee once.
      baseCommissionNetted:
        netBaseQuantity.isZero() && baseCommission.gt(0) ? baseCommission.toString() : null,
      tradeIds: group.map((f) => f.id),
      closedAt: new Date(closedAtMs).toISOString(),
      raw: null,
    };
  });
  const profit = totalSellQuote.sub(totalBuyQuote);
  // Fills arrive sorted, so the last one is the closing fill.
  const closing = fills[fills.length - 1];
  return {
    closingTradeId: closing?.id ?? 0,
    closingBinanceOrderId: String(closing?.orderId ?? ''),
    closedAtMs: closing?.time ?? 0,
    totalBuyQuote: totalBuyQuote.toString(),
    totalSellQuote: totalSellQuote.toString(),
    profit: profit.toString(),
    breakdown: {
      [BACKFILL_BUY]: totalBuyQuote.toString(),
      [BACKFILL_SELL]: totalSellQuote.toString(),
    },
    orders,
  };
};

/**
 * Walk fills oldest-first using wallet quantity: BUY adds executed quantity minus a base-asset commission, and SELL subtracts executed quantity. A relative epsilon tolerates step-size dust, but exact zero is still required before a BUY base fee is certified as already present in Recorded cashflow. Orphan sells, meaningful overshoots, and trailing open positions are dropped because they lack a complete cost basis.
 *
 * @param fills - Binance account trades for one symbol; order does not matter.
 * @param baseAsset - Symbol base asset used to net BUY commissions from wallet quantity.
 * @param epsilonRatio - Maximum residual relative to peak quantity treated as step-size dust.
 * @returns Reconstructed cycles plus counts of history gaps that were dropped.
 */
export const reconstructRoundTrips = (
  fills: readonly MyTradeDto[],
  baseAsset: string,
  epsilonRatio = 0.01,
): {
  roundTrips: ReconstructedRoundTrip[];
  skippedOrphanSells: number;
  droppedOvershootCycles: number;
} => {
  const sorted = [...fills].sort((a, b) => a.time - b.time || a.id - b.id);
  const roundTrips: ReconstructedRoundTrip[] = [];
  let current: MyTradeDto[] = [];
  let running = new Decimal(0);
  let peak = new Decimal(0);
  let skippedOrphanSells = 0;
  let droppedOvershootCycles = 0;
  const reset = (): void => {
    current = [];
    running = new Decimal(0);
    peak = new Decimal(0);
  };
  for (const f of sorted) {
    if (f.isBuyer) {
      running = running.add(new Decimal(f.qty).sub(buyBaseCommission(f, baseAsset)));
      if (running.gt(peak)) peak = running;
      current.push(f);
      continue;
    }
    // SELL with no open position: orphan, cannot price the cost basis.
    if (current.length === 0) {
      skippedOrphanSells += 1;
      continue;
    }
    running = running.sub(f.qty);
    current.push(f);
    const epsilon = peak.mul(epsilonRatio);
    if (running.lt(epsilon.neg())) {
      // Sold meaningfully more base than this cycle bought: the surplus has no
      // recorded cost, so the cycle cannot be priced. Drop it, don't emit.
      droppedOvershootCycles += 1;
      reset();
    } else if (!peak.isZero() && running.lte(epsilon)) {
      roundTrips.push(buildRoundTrip(current, baseAsset));
      reset();
    }
  }
  return { roundTrips, skippedOrphanSells, droppedOvershootCycles };
};
