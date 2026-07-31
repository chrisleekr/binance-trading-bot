import { Decimal } from '@app/money';
import type { EquitySnapshotPayload } from '@app/db';

/** One held position as the projection ships it (decimal-strings, may be null). */
export interface SnapshotPosition {
  readonly symbol: string;
  readonly avgEntryPrice: string | null;
  readonly quantity: string | null;
}

export interface ComputeEquityInput {
  readonly quoteAsset: string;
  /** Held positions for the profile (from avg_entry_prices). */
  readonly positions: readonly SnapshotPosition[];
  /** Current price per symbol in quote terms, or null when no ticker is cached. */
  readonly priceOf: (symbol: string) => string | null;
  /** Cumulative realised net-of-fee profit for the profile (trade archive). */
  readonly realizedNetQuote: string;
  /** The benchmark asset symbol (e.g. 'BTC') and its current quote price, null if absent. */
  readonly benchmarkAsset: string;
  readonly benchmarkPriceQuote: string | null;
}

const ZERO = new Decimal(0);

/**
 * Build one net-P/L snapshot from a profile's positions, prices, and realised
 * P/L. Pure: all money math is Decimal, serialised to decimal-strings.
 *
 * A held symbol with no cached ticker is marked at its average entry price (zero
 * unrealised for that leg) rather than dropped, so a transient missing price
 * neither spikes nor zeroes the curve. A position missing avgEntryPrice or
 * quantity contributes nothing.
 */
export const computeEquitySnapshot = (input: ComputeEquityInput): EquitySnapshotPayload => {
  let positionValue = ZERO;
  let positionCost = ZERO;
  // Real per-symbol mark prices for the basket-hold benchmark. Only symbols with
  // an actual cached ticker are recorded — a leg marked at cost (missing price)
  // must not enter the basket index, or a transient gap would read as 0% return.
  const benchmarkPrices: Record<string, string> = {};
  for (const p of input.positions) {
    if (p.avgEntryPrice === null || p.quantity === null) continue;
    const qty = new Decimal(p.quantity);
    if (qty.lte(0)) continue;
    const avg = new Decimal(p.avgEntryPrice);
    const priceStr = input.priceOf(p.symbol);
    // No ticker → mark at cost (zero unrealised) so a missing price is neutral.
    const mark = priceStr === null ? avg : new Decimal(priceStr);
    if (priceStr !== null) benchmarkPrices[p.symbol] = priceStr;
    positionValue = positionValue.add(mark.mul(qty));
    positionCost = positionCost.add(avg.mul(qty));
  }
  const realizedNet = new Decimal(input.realizedNetQuote);
  const unrealized = positionValue.sub(positionCost);
  const netPnl = realizedNet.add(unrealized);
  const benchmarkPrice =
    input.benchmarkPriceQuote === null ? ZERO : new Decimal(input.benchmarkPriceQuote);

  return {
    quoteAsset: input.quoteAsset,
    netPnlQuote: netPnl.toString(),
    realizedNetQuote: realizedNet.toString(),
    positionValueQuote: positionValue.toString(),
    positionCostQuote: positionCost.toString(),
    benchmarkAsset: input.benchmarkAsset,
    benchmarkPriceQuote: benchmarkPrice.toString(),
    benchmarkPrices,
  };
};
