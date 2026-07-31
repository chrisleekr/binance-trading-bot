import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { numeric38_18 } from './_types.js';
import { profiles } from './profiles.js';

/**
 * Append-only, profile-scoped net-P/L time series. The worker's
 * `equity-snapshot` cron records one row per cadence with the profile's
 * cumulative NET-of-fee profit (realised from the trade archive + unrealised
 * mark-to-market of open positions) and a passive benchmark price, so the live
 * "is the bot beating buy-and-hold?" question has a curve, not a single number.
 *
 * Why net P/L, not account NAV: this is single-account / multi-profile, so cash
 * is not partitioned per profile and an absolute per-profile equity is
 * ill-defined. A profile's net P/L (cost-basis realised + position
 * mark-to-market) IS well-defined and is the honest per-profile scorecard.
 */
export const equitySnapshots = pgTable(
  'equity_snapshots',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
    quoteAsset: text('quote_asset').notNull(),
    /** Cumulative net-of-fee profit = realisedNet + unrealised mark-to-market. */
    netPnlQuote: numeric38_18('net_pnl_quote').notNull(),
    /** Cumulative realised net-of-fee profit from the trade archive. */
    realizedNetQuote: numeric38_18('realized_net_quote').notNull(),
    /** Mark-to-market value of open positions (sum of currentPrice * heldQty). */
    positionValueQuote: numeric38_18('position_value_quote').notNull(),
    /** Cost basis of open positions (sum of avgEntryPrice * heldQty). */
    positionCostQuote: numeric38_18('position_cost_quote').notNull(),
    /** Passive comparator, e.g. 'BTC'. The asset a buy-and-hold line tracks. */
    benchmarkAsset: text('benchmark_asset').notNull(),
    /** Benchmark price in the quote asset at capture, or '0' when unavailable. */
    benchmarkPriceQuote: numeric38_18('benchmark_price_quote').notNull(),
    /**
     * Per-symbol mark prices at capture (symbol → quote-price string) for the
     * profile's held positions, so the equal-weight basket-hold line is derivable
     * at render time. null on rows written before this column shipped.
     */
    benchmarkPrices: jsonb('benchmark_prices').$type<Record<string, string>>(),
  },
  (table) => [
    index('equity_snapshots_profile_captured').on(table.profileId, table.capturedAt.desc()),
  ],
);

export type EquitySnapshotRow = typeof equitySnapshots.$inferSelect;
/** The numbers a single capture writes (decimal-strings end-to-end). */
export interface EquitySnapshotPayload {
  readonly quoteAsset: string;
  readonly netPnlQuote: string;
  readonly realizedNetQuote: string;
  readonly positionValueQuote: string;
  readonly positionCostQuote: string;
  readonly benchmarkAsset: string;
  readonly benchmarkPriceQuote: string;
  /** Held-symbol mark prices at capture; omitted when no tickers were cached. */
  readonly benchmarkPrices?: Record<string, string>;
}
