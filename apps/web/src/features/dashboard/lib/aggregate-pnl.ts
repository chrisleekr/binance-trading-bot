// Home-screen card P/L: the unrealised P/L across a profile's open positions,
// grouped by quote asset so each total carries its unit (a profile holding
// SOL/USDT and a hypothetical *BTC pair must not sum into one bare number).
// The `/dashboard-aggregate` rollup ships the raw decimal-string position
// inputs (decimal.js is barred on the server read path); the sum is a
// display-only `Number` calculation, safe in apps/web.

import { deriveQuote } from '@/shared/lib/symbol-quote';
import { managedUnrealisedPnlOf } from '@/features/profile/lib/unrealised-pnl';

/** One quote asset's summed unrealised P/L, as a decimal-string for {@link PnlValue}. */
export interface QuotePnl {
  readonly quote: string;
  readonly pnl: string;
}

/**
 * Unrealised P/L for a profile's open positions, summed per quote asset and
 * sorted by quote for a stable order. Positions without a live price are
 * skipped — a partial sum still beats showing nothing while one symbol's
 * ticker lags. Returns an empty array when the profile is flat or no position
 * has a price yet, so the card shows an em-dash rather than a misleading `0`.
 * A symbol whose quote can't be parsed falls back to the raw symbol as the
 * group key, so its P/L is still surfaced rather than silently dropped.
 */
// Structural input: serves both DashboardPositionInput (home-screen rollup) and
// ProfileDashboardSymbol (the live ticker), which both carry these fields.
export function aggregatePositionPnl(
  positions: readonly {
    symbol: string;
    avgEntryPrice: string | null;
    currentPrice: string | null;
    quantity: string | null;
    positionSeedRefusal?: { readonly code: string; readonly since: string } | null | undefined;
  }[],
): QuotePnl[] {
  const byQuote = new Map<string, number>();
  for (const p of positions) {
    // A refused seed contributes nothing. This is the headline sum in the top bar, so unlike a wrong table row the operator can discount, a P/L on a position nothing sellable backs silently moves the figure they read as their live money.
    const pnl = managedUnrealisedPnlOf(p);
    if (pnl == null) continue;
    const quote = deriveQuote(p.symbol) ?? p.symbol;
    byQuote.set(quote, (byQuote.get(quote) ?? 0) + pnl);
  }
  return [...byQuote.entries()]
    .map(([quote, sum]) => ({ quote, pnl: String(Number(sum.toFixed(8))) }))
    .sort((a, b) => a.quote.localeCompare(b.quote));
}
