// Symbol-suffix → quote-asset parsing.
//
// Binance symbols are `<base><quote>` concatenations with no separator —
// `BTCUSDT`, `ETHBTC`, `BNBBUSD`. To populate a quote-currency selector
// from a profile's actual symbols we walk a known-quote suffix list,
// longest-first so the longer suffixes (USDT, USDC, BUSD, FDUSD) match
// before their shorter overlaps. A symbol whose suffix isn't in the
// known set returns `null` — the caller decides whether to surface the
// gap or silently drop the row.
//
// The list mirrors Binance Spot's documented quote-asset universe as of
// 2026; adding a new fiat or stablecoin is a one-line constant change.

/**
 * Quote suffixes Binance Spot publishes. Ordered longest-first so the
 * `endsWith` walk hits FDUSD/BUSD/USDT/USDC before the shorter overlaps
 * (BTC, BNB, EUR). A symbol whose base happens to spell out a quote
 * (e.g. a hypothetical `BUSDBTC`) would still resolve to BTC — Binance
 * doesn't list such collisions today, and the longest-first walk keeps
 * the result deterministic if one ever surfaces.
 */
const KNOWN_QUOTES = [
  'FDUSD',
  'BUSD',
  'TUSD',
  'USDC',
  'USDT',
  'DAI',
  'AUD',
  'BRL',
  'EUR',
  'GBP',
  'JPY',
  'TRY',
  'BNB',
  'BTC',
  'ETH',
  'XRP',
  'TRX',
] as const;

/**
 * Returns the quote asset for a Binance symbol string, or `null` when
 * the suffix doesn't match a known quote. The match requires the base
 * to be non-empty so a degenerate `USDT`-only string doesn't claim
 * itself as both base and quote.
 */
export const deriveQuote = (symbol: string): string | null => {
  for (const q of KNOWN_QUOTES) {
    if (symbol.length > q.length && symbol.endsWith(q)) return q;
  }
  return null;
};

/**
 * Base asset of a Binance symbol given its quote asset: the symbol with the
 * quote suffix stripped. Returns `null` when the symbol does not end with the
 * quote asset (a different pair) or stripping would leave nothing. Unlike
 * {@link deriveQuote} the quote is known here, so a plain suffix strip is exact.
 */
export const deriveBase = (symbol: string, quoteAsset: string): string | null => {
  if (symbol.length <= quoteAsset.length || !symbol.endsWith(quoteAsset)) return null;
  return symbol.slice(0, -quoteAsset.length);
};

/**
 * Distinct quote currencies appearing across the given symbol list,
 * alphabetically sorted. Unparseable symbols are silently dropped — the
 * resulting list is what an operator-facing quote-currency selector
 * should show.
 */
export const distinctQuotes = (
  symbols: readonly { readonly symbol: string }[],
): readonly string[] => {
  const set = new Set<string>();
  for (const s of symbols) {
    const q = deriveQuote(s.symbol);
    if (q !== null) set.add(q);
  }
  return [...set].sort();
};
