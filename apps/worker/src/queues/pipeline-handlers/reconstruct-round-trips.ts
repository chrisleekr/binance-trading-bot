// Pure round-trip reconstruction from Binance `myTrades` fills, for the
// `backfill-trade-archive` handler. The forward archive aggregates the local
// `orders` table, but historic BUY rows can be ghost-missing, so the backfill
// rebuilds realised P/L purely from trade history. No I/O, no clock: a fills
// array in, reconstructed round-trips out, so it is fully unit-testable.

import { Decimal } from '@app/money';
import type { MyTradeDto } from '@app/binance';

/**
 * One reconstructed order, grouped from the fills of a single Binance
 * `orderId`. The archive row's `orders` jsonb is not surfaced by the API, so
 * this exists for the audit/detail record and to carry `tradeIds` — the
 * backfill's idempotency marker (re-run skips a round-trip whose closing
 * trade id is already present). `clientOrderId`/`raw` are null because
 * `myTrades` never returns them and the ghost orders have no local row.
 */
export interface ReconstructedOrderSummary {
  readonly orderId: string;
  readonly binanceOrderId: string;
  readonly clientOrderId: null;
  readonly intent: string;
  readonly side: 'BUY' | 'SELL';
  readonly status: 'FILLED';
  readonly qty: string;
  readonly tradeIds: number[];
  readonly closedAt: string;
  readonly raw: null;
}

/**
 * A completed buy-then-emptied cycle. Quote totals and `profit` are GROSS
 * (fees ride alongside in `fees`, per commission asset), matching the forward
 * archive's shape. `breakdown` uses `backfill:BUY`/`backfill:SELL` keys (no
 * strategy intent is recoverable from trade history). `closingTradeId` is the
 * last fill's trade id, stamped for idempotency; `closedAtMs` drives the
 * archive row's `archivedAt` so historic P/L lands at its real trade time.
 */
export interface ReconstructedRoundTrip {
  readonly closingTradeId: number;
  /**
   * Binance order id of the fill that flattened the cycle. The re-run guard
   * keys on this rather than on any order in the cycle: a BUY order whose
   * partial fills straddle a flat-out belongs to two cycles, and matching on
   * any shared order would drop the second one as a duplicate.
   */
  readonly closingBinanceOrderId: string;
  readonly closedAtMs: number;
  readonly totalBuyQuote: string;
  readonly totalSellQuote: string;
  readonly profit: string;
  readonly profitPercent: string;
  readonly breakdown: Record<string, string>;
  readonly fees: Record<string, string>;
  readonly orders: ReconstructedOrderSummary[];
}

const BACKFILL_BUY = 'backfill:BUY';
const BACKFILL_SELL = 'backfill:SELL';

const buildRoundTrip = (fills: readonly MyTradeDto[]): ReconstructedRoundTrip => {
  let totalBuyQuote = new Decimal(0);
  let totalSellQuote = new Decimal(0);
  const feeSums = new Map<string, Decimal>();
  // Group fills into one synthetic order per Binance orderId (a single order
  // fills as one or more trades). All fills of an order share a side.
  const byOrder = new Map<number, MyTradeDto[]>();
  for (const f of fills) {
    const quote = new Decimal(f.quoteQty);
    if (f.isBuyer) totalBuyQuote = totalBuyQuote.add(quote);
    else totalSellQuote = totalSellQuote.add(quote);
    feeSums.set(
      f.commissionAsset,
      (feeSums.get(f.commissionAsset) ?? new Decimal(0)).add(f.commission),
    );
    const group = byOrder.get(f.orderId);
    if (group) group.push(f);
    else byOrder.set(f.orderId, [f]);
  }
  const orders: ReconstructedOrderSummary[] = [...byOrder.entries()].map(([orderId, group]) => {
    const qty = group.reduce((sum, f) => sum.add(f.qty), new Decimal(0));
    const closedAtMs = group.reduce((m, f) => Math.max(m, f.time), 0);
    return {
      orderId: String(orderId),
      binanceOrderId: String(orderId),
      clientOrderId: null,
      intent: 'backfill',
      side: group[0]?.isBuyer ? 'BUY' : 'SELL',
      status: 'FILLED',
      qty: qty.toString(),
      tradeIds: group.map((f) => f.id),
      closedAt: new Date(closedAtMs).toISOString(),
      raw: null,
    };
  });
  const profit = totalSellQuote.sub(totalBuyQuote);
  const profitPercent = totalBuyQuote.isZero()
    ? new Decimal(0)
    : profit.div(totalBuyQuote).mul(100);
  // Fills arrive sorted, so the last one is the closing fill.
  const closing = fills[fills.length - 1];
  return {
    closingTradeId: closing?.id ?? 0,
    closingBinanceOrderId: String(closing?.orderId ?? ''),
    closedAtMs: closing?.time ?? 0,
    totalBuyQuote: totalBuyQuote.toString(),
    totalSellQuote: totalSellQuote.toString(),
    profit: profit.toString(),
    profitPercent: profitPercent.toString(),
    breakdown: {
      [BACKFILL_BUY]: totalBuyQuote.toString(),
      [BACKFILL_SELL]: totalSellQuote.toString(),
    },
    fees: Object.fromEntries([...feeSums].map(([asset, total]) => [asset, total.toString()])),
    orders,
  };
};

/**
 * Walk fills oldest-first tracking running base quantity (BUY adds, SELL
 * subtracts) and emit a round-trip each time the position empties back to
 * ~zero. The epsilon is relative to the round-trip's peak position so
 * base-asset fee residue and stepSize dust don't keep a finished cycle open,
 * while a genuine partial sell (which leaves a large remainder) does not
 * close it early.
 *
 * Two cases yield un-costed base, where no honest P/L can be reconstructed,
 * so they are dropped and surfaced (never silently emitted as profit):
 *  - `skippedOrphanSells`: a SELL while flat (its matching BUYs predate the
 *    supplied history).
 *  - `droppedOvershootCycles`: a cycle whose SELLs draw the running quantity
 *    meaningfully below zero (sold more base than this cycle bought — the
 *    surplus came from a pre-history position). Counting the oversized sell's
 *    proceeds as profit would inflate realised P/L, so the whole cycle is
 *    discarded.
 *
 * A trailing open position (bought but not fully sold) is also dropped: it has
 * no realised P/L yet. The close epsilon is relative to the cycle's peak so
 * base-asset fee dust does not keep a finished cycle open; a zero-peak cycle
 * (only zero-qty fills) can never emit.
 */
export const reconstructRoundTrips = (
  fills: readonly MyTradeDto[],
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
      running = running.add(f.qty);
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
      roundTrips.push(buildRoundTrip(current));
      reset();
    }
  }
  return { roundTrips, skippedOrphanSells, droppedOvershootCycles };
};
