// buildTickerMetrics — pure rollup for the dashboard ticker strip. Over
// live+enabled profiles only (practice/testnet and paused profiles never reach
// the headline), it counts open positions/orders, sums realised P/L today and
// unrealised P/L per quote, and lists each held coin with its unrealised P/L.
//
// Money here is a display-only Number calculation, the same boundary
// aggregate-pnl.ts / unrealised-pnl.ts work at: decimal.js is barred on the web
// read path, so the browser sums the decimal-string facts the server ships.
// toFixed clamps IEEE drift before stringifying; PnlValue/formatMoneyAmount
// decide the displayed precision.

import type { DashboardAggregateRow, ProfileDashboardSymbol } from '@app/contracts';

import { aggregatePositionPnl } from '@/features/dashboard/lib/aggregate-pnl';
import {
  isManagedPosition,
  managedUnrealisedPnlOf,
  toFinite,
} from '@/features/profile/lib/unrealised-pnl';
import { deriveQuote } from '@/shared/lib/symbol-quote';

/** One realised-today entry: a profile's period P/L tagged with its quote unit. */
export interface RealisedEntry {
  readonly profileId: string;
  readonly quoteAsset: string;
  readonly totalProfit: string;
}

/** One quote asset's summed P/L, as a decimal-string for {@link PnlValue}. */
export interface QuotePnl {
  readonly quote: string;
  readonly pnl: string;
}

/** One held coin: base/quote split, plus unrealised P/L amount and percent. */
export interface CoinHolding {
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  readonly pnl: string;
  readonly pnlPercent: string;
}

/** Ticker headline: live counts, realised + unrealised P/L per quote, holdings. */
export interface TickerMetrics {
  readonly positions: number;
  readonly orders: number;
  readonly realised: QuotePnl[];
  readonly unrealised: QuotePnl[];
  readonly holdings: CoinHolding[];
}

/**
 * Roll the dashboard rows and per-profile realised P/L into the ticker headline.
 * Everything is scoped to live+enabled profiles, so testnet practice funds and
 * paused profiles never reach the operator's at-a-glance strip. Per-quote sums
 * sort by quote, holdings sort by symbol, for a stable render order.
 */
export function buildTickerMetrics(
  rows: readonly DashboardAggregateRow[],
  realised: readonly RealisedEntry[],
  liveSymbols: readonly ProfileDashboardSymbol[],
): TickerMetrics {
  const liveRows = rows.filter((r) => r.binanceMode === 'live' && r.enabled);
  const liveProfileIds = new Set(liveRows.map((r) => r.profileId));

  let positions = 0;
  let orders = 0;
  for (const r of liveRows) {
    positions += r.openPositionCount;
    orders += r.openOrderCount;
  }

  const byQuote = new Map<string, number>();
  for (const entry of realised) {
    if (!liveProfileIds.has(entry.profileId)) continue;
    byQuote.set(entry.quoteAsset, (byQuote.get(entry.quoteAsset) ?? 0) + Number(entry.totalProfit));
  }
  const realisedOut = [...byQuote.entries()]
    .map(([quote, sum]) => ({ quote, pnl: String(Number(sum.toFixed(8))) }))
    .sort((a, b) => a.quote.localeCompare(b.quote));

  return {
    positions,
    orders,
    realised: realisedOut,
    unrealised: aggregatePositionPnl(liveSymbols),
    holdings: buildHoldings(liveSymbols),
  };
}

/**
 * Per-coin unrealised P/L for the held positions that have a live price. Flat or
 * unpriced positions are skipped so the ticker never shows a contrived 0.
 */
function buildHoldings(positions: readonly ProfileDashboardSymbol[]): CoinHolding[] {
  const out: CoinHolding[] = [];
  for (const p of positions) {
    // The refused seeds are the ones that matter most here. This is a SUM in the top bar, so a P/L on a position nothing backs is not merely one wrong row the operator can discount, it silently moves the headline number they read as their live money.
    if (!isManagedPosition(p)) continue;
    const pnl = managedUnrealisedPnlOf(p);
    if (pnl == null) continue;
    const quote = deriveQuote(p.symbol) ?? '';
    const base = quote && p.symbol.endsWith(quote) ? p.symbol.slice(0, -quote.length) : p.symbol;
    const avg = toFinite(p.avgEntryPrice);
    const cur = toFinite(p.currentPrice);
    const pct = avg != null && avg !== 0 && cur != null ? ((cur - avg) / avg) * 100 : null;
    out.push({
      symbol: p.symbol,
      base,
      quote,
      pnl: String(pnl),
      pnlPercent: pct == null ? '' : String(Number(pct.toFixed(2))),
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}
