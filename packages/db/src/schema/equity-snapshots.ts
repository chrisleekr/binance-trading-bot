import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { FeeBasis } from '@app/contracts';
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
    /** Cumulative realised net-of-fee profit from the trade archive, counted ONLY in this row's `quote_asset`: cycles closed under a previous quote are excluded, because this value is ADDED to position legs marked in that same quote. */
    realizedNetQuote: numeric38_18('realized_net_quote').notNull(),
    /** How well the realized Net input's fee component was known when this point was recorded. Every point that HAS a basis is eligible for the chart; only `unknown` is withheld, because only `unknown` is a point with a charge missing. Excluding `estimated` too would read as the more cautious choice and is in fact the destructive one: a third-asset commission is reconstructed from the rate table on the live path as much as on the backfill, so the curve would never gain a point on a BNB-billed account. */
    feeBasis: text('fee_basis').$type<FeeBasis>().notNull().default('unknown'),
    /** Mark-to-market value of open positions (sum of currentPrice * heldQty), counted only over positions settling in this row's `quote_asset` — a holding kept from before a quote change marks in its own currency and is excluded, not converted. */
    positionValueQuote: numeric38_18('position_value_quote').notNull(),
    /** Cost basis of open positions (sum of avgEntryPrice * heldQty), over the same quote-filtered set as `positionValueQuote` so the two subtract to a real unrealised figure. */
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
    check(
      'equity_snapshots_fee_basis_chk',
      sql`${table.feeBasis} in ('exact', 'estimated', 'unknown')`,
    ),
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
  /** How well the realised input's fee component was known. Carried by the caller rather than assumed here: the recorder cannot see where the realised figure came from, and a constant written at the insert makes the column a claim about nothing. */
  readonly feeBasis: FeeBasis;
  /** Held-symbol mark prices at capture; omitted when no tickers were cached. */
  readonly benchmarkPrices?: Record<string, string>;
}
