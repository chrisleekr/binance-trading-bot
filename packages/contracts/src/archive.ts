import Decimal from 'decimal.js';
import { z } from 'zod';
import { asDecimalString, DecimalString, decimalAdd } from './decimal.js';

/**
 * The exit intent of one archived buy/sell cycle: the `intent` of the LAST
 * SELL order in `orders`. The closing SELL is what actually realized the
 * cycle's P/L, so its intent (e.g. `grid-stop-loss`, `technicals-force-sell`,
 * `grid-sell`, `manual`) is the honest "why did this trade close" label. A
 * cycle with no SELL, or a SELL whose intent is missing, is `'unknown'` so
 * recovered/backfilled rows read truthfully rather than being dropped.
 */
export function deriveExitIntent(
  orders: readonly { side: string; intent?: string | null }[],
): string {
  for (let i = orders.length - 1; i >= 0; i--) {
    const o = orders[i];
    if (o !== undefined && o.side === 'SELL') {
      return o.intent != null && o.intent.length > 0 ? baseIntent(o.intent) : 'unknown';
    }
  }
  return 'unknown';
}

/**
 * Coerce the archived `orders` JSONB into the shape {@link deriveExitIntent}
 * needs. The persisted column is untyped at the DB boundary and a malformed or
 * legacy row must not throw the read path, so a non-array value yields `[]`,
 * elements that aren't objects with a string `side` are dropped, and a
 * non-string `intent` is normalised to null.
 */
export function coerceArchivedOrders(value: unknown): { side: string; intent?: string | null }[] {
  if (!Array.isArray(value)) return [];
  const out: { side: string; intent?: string | null }[] = [];
  for (const o of value) {
    if (o !== null && typeof o === 'object' && typeof (o as { side?: unknown }).side === 'string') {
      const intent = (o as { intent?: unknown }).intent;
      out.push({
        side: (o as { side: string }).side,
        intent: typeof intent === 'string' ? intent : null,
      });
    }
  }
  return out;
}

/**
 * A recovery row (an order live on Binance whose normal write failed) is stored under
 * a reserved intent, `<intent>:untracked:<binanceOrderId>` — unique per exchange order
 * by construction, so it cannot collide with a strategy's live slot. That uniqueness is
 * exactly what would wreck this rollup: bucketing by the stored string verbatim would
 * give every recovered SELL its own one-row bucket instead of joining `exit`. Report on
 * the intent the strategy MEANT.
 */
const UNTRACKED_SEP = ':untracked:';
const baseIntent = (intent: string): string => {
  const at = intent.indexOf(UNTRACKED_SEP);
  return at === -1 ? intent : intent.slice(0, at);
};

/**
 * Per-bucket realized-P/L primitives shared by the by-intent and by-source
 * rollups. `profitSum` is the signed GROSS profit (before fees); `totalFees` is
 * the commissions valued in the quote asset, so net = `profitSum - totalFees`.
 * `wins`/`losses` and `grossProfit`/`grossLoss` are computed on NET-of-fee
 * profit — a trade that cleared a gross profit but not its fees is a net loss —
 * so `grossProfit - grossLoss` equals the net profit sum. The wire carries only
 * verbatim decimal sums and integer counts, never a divided ratio: the UI
 * derives win% (`wins`/`tradeCount`), profit factor (`grossProfit`/`grossLoss`),
 * and expectancy at render time so no money value is ever stored as an IEEE-754
 * number. A breakeven trade (net exactly 0) counts in `tradeCount` but in
 * neither `wins` nor `losses`.
 */
const rollupMetricFields = {
  tradeCount: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  profitSum: DecimalString,
  netProfit: DecimalString,
  grossProfit: DecimalString,
  grossLoss: DecimalString,
  totalFees: DecimalString,
} as const;

/** One period-scoped P/L bucket grouped by `(quoteAsset, exitIntent)`. */
export const ByIntentRollupSchema = z.object({
  quoteAsset: z.string(),
  intent: z.string(),
  ...rollupMetricFields,
});
/** TS type derived from {@link ByIntentRollupSchema}. */
export type ByIntentRollup = z.infer<typeof ByIntentRollupSchema>;

/** One period-scoped P/L bucket grouped by `(quoteAsset, source)` (auto = discovery, manual = pinned). */
export const BySourceRollupSchema = z.object({
  quoteAsset: z.string(),
  source: z.string(),
  ...rollupMetricFields,
});
/** TS type derived from {@link BySourceRollupSchema}. */
export type BySourceRollup = z.infer<typeof BySourceRollupSchema>;

/**
 * One period row fed to the archive rollups: its quote, source, GROSS realized
 * profit, the commissions valued in the quote asset (`feesQuote`), and the
 * cycle's orders. `feesQuote` defaults to `'0'` so a producer that has not yet
 * been updated reads as gross-only rather than throwing.
 */
export interface ArchiveRollupItem {
  readonly quoteAsset: string;
  readonly source: string;
  readonly profit: string;
  readonly feesQuote?: string;
  readonly orders: readonly { side: string; intent?: string | null }[];
}

interface RollupBucket {
  quoteAsset: string;
  dimension: string;
  tradeCount: number;
  wins: number;
  losses: number;
  profitSum: string;
  grossProfit: string;
  grossLoss: string;
  totalFees: string;
}

/**
 * Bucket archived trades by `(quoteAsset, dimension)`, where the caller picks
 * `dimension` (exit intent or source). Sums net profit plus the win/loss split
 * and the winners'/losers' gross magnitudes, all in decimal-string space (no
 * IEEE-754) so the rollup never loses precision against the source rows. A
 * breakeven trade (profit 0) is a trade but neither a win nor a loss.
 * Deterministic order: `quoteAsset` then `dimension`, both ascending, so the
 * band renders stably across refetches regardless of input order.
 */
function accumulateBuckets(
  items: readonly ArchiveRollupItem[],
  dimensionOf: (item: ArchiveRollupItem) => string,
): RollupBucket[] {
  const buckets = new Map<string, RollupBucket>();
  for (const item of items) {
    const dimension = dimensionOf(item);
    // Quote assets and intent/source labels never contain a space, so a
    // space-joined key uniquely identifies the (quote, dimension) pair.
    const key = `${item.quoteAsset} ${dimension}`;
    let b = buckets.get(key);
    if (b === undefined) {
      b = {
        quoteAsset: item.quoteAsset,
        dimension,
        tradeCount: 0,
        wins: 0,
        losses: 0,
        profitSum: '0',
        grossProfit: '0',
        grossLoss: '0',
        totalFees: '0',
      };
      buckets.set(key, b);
    }
    b.tradeCount += 1;
    // profitSum is GROSS (before fees); win/loss and the gross winner/loser
    // magnitudes are classified on net = profit - feesQuote so the derived
    // win% and profit factor reflect what was actually kept.
    b.profitSum = decimalAdd(b.profitSum, item.profit);
    const feesQuote = item.feesQuote ?? '0';
    b.totalFees = decimalAdd(b.totalFees, feesQuote);
    const net = new Decimal(item.profit).sub(feesQuote);
    if (net.gt(0)) {
      b.wins += 1;
      b.grossProfit = decimalAdd(b.grossProfit, net.toString());
    } else if (net.lt(0)) {
      b.losses += 1;
      b.grossLoss = decimalAdd(b.grossLoss, net.abs().toString());
    }
  }
  return [...buckets.values()].sort(
    (a, b) => a.quoteAsset.localeCompare(b.quoteAsset) || a.dimension.localeCompare(b.dimension),
  );
}

/** Shared decimal-string projection of a bucket's metrics (everything but the dimension label). */
function bucketMetrics(b: RollupBucket): {
  quoteAsset: string;
  tradeCount: number;
  wins: number;
  losses: number;
  profitSum: DecimalString;
  netProfit: DecimalString;
  grossProfit: DecimalString;
  grossLoss: DecimalString;
  totalFees: DecimalString;
} {
  return {
    quoteAsset: b.quoteAsset,
    tradeCount: b.tradeCount,
    wins: b.wins,
    losses: b.losses,
    profitSum: asDecimalString(b.profitSum),
    // net = gross profit − fees; equals grossProfit − grossLoss by construction.
    netProfit: asDecimalString(new Decimal(b.profitSum).sub(b.totalFees)),
    grossProfit: asDecimalString(b.grossProfit),
    grossLoss: asDecimalString(b.grossLoss),
    totalFees: asDecimalString(b.totalFees),
  };
}

/**
 * Group archived trades by `(quoteAsset, exitIntent)`. The exit intent is
 * derived per row via {@link deriveExitIntent} (the last SELL's intent), so
 * callers pass the raw archived `orders` and the rollup owns the derivation.
 */
export function rollupByExitIntent(items: readonly ArchiveRollupItem[]): ByIntentRollup[] {
  return accumulateBuckets(items, (item) => deriveExitIntent(item.orders)).map((b) => ({
    ...bucketMetrics(b),
    intent: b.dimension,
  }));
}

/** Group archived trades by `(quoteAsset, source)` so the operator sees discovery vs manual edge. */
export function rollupBySource(items: readonly ArchiveRollupItem[]): BySourceRollup[] {
  return accumulateBuckets(items, (item) => item.source).map((b) => ({
    ...bucketMetrics(b),
    source: b.dimension,
  }));
}

/** One overall closed-trade summary (the per-quote/source split collapsed). */
export interface ClosedTradesSummary {
  readonly tradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly grossProfit: string;
  readonly grossLoss: string;
  readonly netProfit: string;
  readonly totalFees: string;
}

const EMPTY_CLOSED_TRADES_SUMMARY: ClosedTradesSummary = {
  tradeCount: 0,
  wins: 0,
  losses: 0,
  grossProfit: '0',
  grossLoss: '0',
  netProfit: '0',
  totalFees: '0',
};

/**
 * Collapse a profile's closed trades into one net-of-fee summary, ignoring the
 * quote/source partition the rollups carry. Same win/loss net classification as
 * the rollups (a single all-bucket accumulation), so the headline profit factor
 * the edge-decay monitor compares against the baseline is computed identically
 * to the scorecard's. Empty input yields the all-zero summary, not a throw.
 */
export function summarizeClosedTrades(items: readonly ArchiveRollupItem[]): ClosedTradesSummary {
  const bucket = accumulateBuckets(items, () => 'all')[0];
  if (bucket === undefined) return EMPTY_CLOSED_TRADES_SUMMARY;
  const m = bucketMetrics(bucket);
  return {
    tradeCount: m.tradeCount,
    wins: m.wins,
    losses: m.losses,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
    netProfit: m.netProfit,
    totalFees: m.totalFees,
  };
}

/**
 * Closed-trade archive row: the long-term record of one buy/sell cycle.
 * `totalBuyQuote`/`totalSellQuote` and `profit` are strategy-agnostic
 * (sum of the filled BUY/SELL quote, profit = sell - buy). `breakdown` is
 * the strategy-specific decomposition: a map keyed by `"<intent>:<side>"`
 * to the summed quote for that pair, so the operator's P&L UI can show a
 * per-intent split without re-aggregating the orders table. TT populates
 * keys like `grid-buy:BUY`, `manual:SELL`, `grid-stop-loss:SELL`; another
 * strategy uses its own intents (e.g. `entry:BUY`, `exit:SELL`).
 */
export const TradeArchiveResponse = z.object({
  id: z.uuid(),
  symbol: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  totalBuyQuote: DecimalString,
  totalSellQuote: DecimalString,
  breakdown: z.record(z.string(), DecimalString),
  // Binance commissions for the cycle, summed per commission asset (key =
  // asset, value = total paid). Empty when trade history was unavailable at
  // archive time.
  fees: z.record(z.string(), DecimalString),
  // The cycle's commissions valued in the quote asset, so the row can show net
  // P/L (`profit - feesQuote`). `.default('0')` keeps pre-column producers and
  // backfilled rows valid (they report gross until re-archived).
  feesQuote: DecimalString.default(asDecimalString('0')),
  // Realised P/L net of fees (`profit - feesQuote`), server-computed so the row
  // need not re-derive it. `.default('0')` keeps older producers valid.
  netProfit: DecimalString.default(asDecimalString('0')),
  profit: DecimalString,
  profitPercent: DecimalString,
  // Why the cycle closed: the intent of the last SELL order, derived at read
  // time from the archived `orders` (no stored column). `'unknown'` for rows
  // with no SELL or a missing intent (e.g. backfilled history). `.default`
  // keeps pre-existing response producers/consumers from breaking.
  exitIntent: z.string().default('unknown'),
  // How many SELLs in this cycle had no cost basis. Those contribute nothing to
  // `profit`, so a positive count means `profit`/`netProfit`/`profitPercent`
  // are a conservative UNDER-count and must be presented as unavailable — a
  // zero here reads as a measured break-even, which it is not. `.default(0)`
  // keeps pre-column producers valid (they were fully costed or unknowable).
  missingCostBasis: z.number().int().nonnegative().default(0),
  archivedAt: z.iso.datetime(),
});
/** TS type derived from {@link TradeArchiveResponse} so consumers don't re-run z.infer at every call site. */
export type TradeArchiveResponse = z.infer<typeof TradeArchiveResponse>;

/** Paginated archive list. Cursor-based for stable pages over a growing table. */
export const TradeArchiveList = z.object({
  items: z.array(TradeArchiveResponse),
  nextCursor: z.string().optional(),
});
/** TS type derived from {@link TradeArchiveList} so consumers don't re-run z.infer at every call site. */
export type TradeArchiveList = z.infer<typeof TradeArchiveList>;

/**
 * Period selector for the archive page. `'a'` = all time, `'d'` = day,
 * `'w'` = week, `'m'` = month. Locale/timezone-aware boundaries live on
 * the API side because the closed-trades widget already owns that helper;
 * keeping the same enum lets the operator's mental model carry across.
 */
export const ArchivePeriod = z.enum(['a', 'd', 'w', 'm']);
/** TS type derived from {@link ArchivePeriod} so consumers don't re-run z.infer at every call site. */
export type ArchivePeriod = z.infer<typeof ArchivePeriod>;

/**
 * Why a coin's history could not be reconstructed from Binance trade history:
 * `orphan-sells` (a SELL with no recorded matching BUY), `overshoot` (sold more
 * base than was bought here), `symbol-unavailable` (Binance no longer lists the
 * pair, so there is no history left to read), or `open-or-pre-history`
 * (bought-not-fully-sold, or the cycle predates the returned history). The UI
 * glosses each.
 *
 * `symbol-unavailable` is its own reason rather than folded into the zero-count
 * case: a delisted coin labelled "an open or pre-history position" is a plainly
 * wrong explanation, and it is the one reason no future retry can change.
 */
export const UnreconstructableReason = z.enum([
  'open-or-pre-history',
  'orphan-sells',
  'overshoot',
  'symbol-unavailable',
]);
export type UnreconstructableReason = z.infer<typeof UnreconstructableReason>;

/**
 * Cursor-paginated profile-level archive response. `nextCursor` is opaque
 * (composite `<archivedAt-iso>__<id>` so a same-timestamp group is paged
 * stably); the client treats it as a string and echoes it back via
 * `?cursor=`. Null when the page came up shorter than the requested
 * limit.
 */
export const ProfileArchiveListResponse = z.object({
  items: z.array(TradeArchiveResponse),
  nextCursor: z.string().nullable(),
  // Coins with fills, no archive row, and not yet backfilled — the actionable
  // "may have unsaved P/L, recover it" set. Drives the recover-all nudge.
  recoverableSymbols: z.array(z.string()).default([]),
  // Coins a backfill already tried and could not reconstruct (no complete
  // buy→sell cycle). Surfaced as a quiet, non-actionable note with a reason, so
  // a coin that can never be rebuilt explains itself instead of nagging in the
  // recover nudge forever.
  // `dismissed` coins are operator-hidden; still returned so the UI can offer a
  // "show hidden" reveal and un-hide.
  unreconstructableSymbols: z
    .array(
      z.object({ symbol: z.string(), reason: UnreconstructableReason, dismissed: z.boolean() }),
    )
    .default([]),
  // Period-scoped P/L grouped by exit intent over EVERY trade in the selected
  // period (not just the visible page), so the operator sees which exit reason
  // is winning or bleeding across the whole window. `.default([])` keeps older
  // producers valid.
  byIntent: z.array(ByIntentRollupSchema).default([]),
  // Same period-scoped rollup grouped by symbol source (auto = discovery,
  // manual = pinned) so the operator sees whether the discovery engine or
  // manual trading is the edge or the drag. `.default([])` keeps older
  // producers valid.
  bySource: z.array(BySourceRollupSchema).default([]),
});
/** TS type derived from {@link ProfileArchiveListResponse} so consumers don't re-run z.infer at every call site. */
export type ProfileArchiveListResponse = z.infer<typeof ProfileArchiveListResponse>;

/**
 * Request to backfill `trade_archive` from Binance `myTrades` for one
 * `(profile, symbol)`. A one-off operator recovery for round-trips that
 * completed before the forward archive existed, where the local `orders`
 * rows are missing so reconstruction must come from Binance trade history.
 *
 * `from`/`to` optionally bound which reconstructed round-trips are kept, by
 * the round-trip's closing-fill time. Scope the window to the period before
 * forward archiving began so the backfill does not duplicate round-trips the
 * forward path already recorded (forward rows carry no trade-id marker, so
 * the backfill's own re-run guard cannot detect that overlap).
 */
export const TradeArchiveBackfillRequest = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
});
/** TS type derived from {@link TradeArchiveBackfillRequest} so consumers don't re-run z.infer at every call site. */
export type TradeArchiveBackfillRequest = z.infer<typeof TradeArchiveBackfillRequest>;

/** Accepted-backfill acknowledgement; the reconstruction runs on the worker. */
export const TradeArchiveBackfillResponse = z.object({
  scheduledAt: z.iso.datetime(),
});
/** TS type derived from {@link TradeArchiveBackfillResponse} so consumers don't re-run z.infer at every call site. */
export type TradeArchiveBackfillResponse = z.infer<typeof TradeArchiveBackfillResponse>;

/** Hide (`true`) or un-hide (`false`) an unreconstructable coin from the note. */
export const UnreconstructableDismissRequest = z.object({ dismissed: z.boolean() });
export type UnreconstructableDismissRequest = z.infer<typeof UnreconstructableDismissRequest>;

/** Echoes the resulting visibility after a dismiss/un-hide. */
export const UnreconstructableDismissResponse = z.object({ dismissed: z.boolean() });
export type UnreconstructableDismissResponse = z.infer<typeof UnreconstructableDismissResponse>;
