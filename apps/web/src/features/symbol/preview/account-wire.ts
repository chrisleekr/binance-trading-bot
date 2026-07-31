// Build the wire account snapshot the preview passes to a strategy that sizes
// off free cash (momentum's percent-of-account entry). Balances stay
// decimal-strings — apps/web cannot build Decimal — and the strategy revives
// them at its own boundary.

import type { ExchangeInfoSymbol } from '@app/contracts';
import type { AccountSnapshotWire, SymbolFilters } from '@app/strategy-core';

interface WireBalance {
  readonly asset: string;
  readonly free: string;
  readonly locked: string;
}

/** From the profile dashboard's string balances + deployed cost-basis. */
export const accountWireFromBalances = (
  balances: readonly WireBalance[],
  deployedQuote: string,
): AccountSnapshotWire => ({
  balances: Object.fromEntries(balances.map((b) => [b.asset, { free: b.free, locked: b.locked }])),
  deployedQuoteAcrossProfiles: deployedQuote,
});

/**
 * Synthetic account for the backtest configure tab: the operator's typed
 * starting quote balance as free cash of the quote asset, nothing deployed. The
 * backtest has no live wallet, so this mirrors the engine's opening balance.
 */
export const syntheticBacktestAccount = (
  quoteAsset: string,
  initialQuoteBalance: string,
): AccountSnapshotWire => ({
  balances: { [quoteAsset]: { free: initialQuoteBalance, locked: '0' } },
  deployedQuoteAcrossProfiles: '0',
});

/**
 * The exchangeInfo row's sizing filters, as the strategy preview's
 * `SymbolFilters` — or `undefined` when the row (or its filter set) is absent, so
 * momentum's preview falls back to the band-only projection. Pure passthrough:
 * apps/web bars decimal.js, so no math here.
 */
export const filtersFromExchangeInfoSymbol = (
  sym: ExchangeInfoSymbol | undefined,
): SymbolFilters | undefined => sym?.filters ?? undefined;
