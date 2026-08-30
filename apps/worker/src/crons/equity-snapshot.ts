import { Decimal } from '@app/money';
import type { FeeBasis } from '@app/contracts';
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
  /** How well the fee component of `realizedNetQuote` is known. Carried through unchanged: the unrealised legs are marked from live tickers and add no fee evidence either way, so the row is exactly as trustworthy as its realised input was. */
  readonly feeBasis: FeeBasis;
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
 *
 * Every leg is counted in `input.quoteAsset` and nothing else. The realised leg arrives pre-filtered, and a position is admitted only when its symbol settles in that same asset, because the two are ADDED: an `ETHUSDT` holding marked at a USDT price would otherwise land in a BTC-denominated row, which is the cross-currency defect this snapshot exists to report rather than commit. A quote change deliberately keeps old-quote holdings alive rather than force-selling them, so this is the normal path after one, not a corrupt state. Such a leg is EXCLUDED, never converted: there is no rate source here, and inventing one would put market risk inside an accounting number.
 *
 * @param input - One profile's snapshot inputs. `quoteAsset` is both the denomination of every figure returned AND the admission test each position must pass, so it governs which legs exist at all, not just the label; `positions` is the raw avg-entry ledger, which may still hold symbols from a previous quote; `priceOf` resolves a cached ticker or null; `realizedNetQuote` arrives already counted in `quoteAsset` and `feeBasis` says how well its fees were known; `benchmarkAsset` and `benchmarkPriceQuote` carry the passive buy-and-hold comparator.
 * @returns The row to persist: realised, position value, and position cost all counted in `quoteAsset`, their sum as `netPnlQuote`, and `benchmarkPrices` holding only the admitted legs that had a real cached price.
 */
export const computeEquitySnapshot = (input: ComputeEquityInput): EquitySnapshotPayload => {
  let positionValue = ZERO;
  let positionCost = ZERO;
  // Real per-symbol mark prices for the basket-hold benchmark. Only symbols with
  // an actual cached ticker are recorded — a leg marked at cost (missing price)
  // must not enter the basket index, or a transient gap would read as 0% return.
  const benchmarkPrices: Record<string, string> = {};
  // Symbols carry Binance's upper casing; `profiles.quote_asset` is allowed to be stored lower or mixed case, so comparing them raw would reject every position of a profile whose quote reads `usdt` and flatline its curve at zero.
  const quote = input.quoteAsset.toUpperCase();
  for (const p of input.positions) {
    // Suffix test, matching `baseAssetOf` and the `base_asset` backfill: a pair that does not decompose against this quote is one we must not guess at. The length guard is theirs too — a symbol that is ONLY the quote has no base, so it is not a position in this quote, it is unresolvable.
    const symbol = p.symbol.toUpperCase();
    if (!symbol.endsWith(quote) || symbol.length <= quote.length) continue;
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
    // Canonical, not the caller's casing: the legs above were admitted by comparing against the upper-cased quote, so labelling the row with a different spelling of the same asset would make the label disagree with the filter that produced it.
    quoteAsset: quote,
    netPnlQuote: netPnl.toString(),
    realizedNetQuote: realizedNet.toString(),
    positionValueQuote: positionValue.toString(),
    positionCostQuote: positionCost.toString(),
    benchmarkAsset: input.benchmarkAsset,
    benchmarkPriceQuote: benchmarkPrice.toString(),
    feeBasis: input.feeBasis,
    benchmarkPrices,
  };
};
