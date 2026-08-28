import Decimal from 'decimal.js';
import { z } from 'zod';
import { asDecimalString, DecimalString, decimalAdd } from './decimal.js';

/**
 * The exit intent of one archived buy/sell cycle: the `intent` of the SELL that closed it, i.e. the one with the greatest `closedAt`. The closing SELL is what actually realized the cycle's P/L, so its intent (e.g. `grid-stop-loss`, `technicals-force-sell`, `grid-sell`, `manual`) is the honest "why did this trade close" label. A cycle with no SELL, or a SELL whose intent is missing, is `'unknown'` so recovered/backfilled rows read truthfully rather than being dropped.
 *
 * Selection is by timestamp, never by array position, because no writer guarantees a chronological array and the two disagree: the forward archive emits `desc(closedAt)` so its LAST SELL is the cycle's FIRST exit, and the backfill emits Map-insertion order keyed on each order's FIRST fill, so an order that partially fills, yields to a second SELL, then flattens the position lands before that second SELL. Reading by position picked the wrong SELL in both, which mislabels every cycle closed by more than one SELL and mis-buckets the by-exit-reason rollup that shares this function.
 *
 * Rows written before `closedAt` was carried, or whose stamps are unparseable, keep the previous last-in-array behaviour: with nothing to order by, position is the only signal left.
 *
 * @param orders - Archived order summaries of one cycle, in any order.
 * @returns The closing SELL's base intent, or `'unknown'` when no SELL carries one.
 */
export function deriveExitIntent(
  orders: readonly { side: string; intent?: string | null; closedAt?: string | null }[],
): string {
  let closing: { intent?: string | null } | undefined;
  let closingAt = -Infinity;
  for (const order of orders) {
    if (order.side !== 'SELL') continue;
    const at = order.closedAt == null ? NaN : Date.parse(order.closedAt);
    if (Number.isNaN(at)) {
      // Unstamped rows only compete with each other, and the last one wins, which is the legacy behaviour. One stamped SELL retires them all.
      if (closingAt === -Infinity) closing = order;
      continue;
    }
    // `>=` keeps the later array element on a tie, so equal stamps degrade to the same last-wins rule.
    if (at >= closingAt) {
      closing = order;
      closingAt = at;
    }
  }
  const intent = closing?.intent;
  return intent != null && intent.length > 0 ? baseIntent(intent) : 'unknown';
}

/**
 * Coerce the archived `orders` JSONB into the shape {@link deriveExitIntent}
 * needs. The persisted column is untyped at the DB boundary and a malformed or legacy row must not throw the read path, so a non-array value yields `[]`, elements that aren't objects with a string `side` are dropped, and a non-string `intent` or `closedAt` is normalised to null. `closedAt` is carried because {@link deriveExitIntent} orders by it.
 *
 * @param value - The raw `orders` JSONB as read from the archive row, of unknown shape.
 * @returns Well-formed order summaries, possibly empty; never throws.
 */
export function coerceArchivedOrders(
  value: unknown,
): { side: string; intent?: string | null; closedAt?: string | null }[] {
  if (!Array.isArray(value)) return [];
  const out: { side: string; intent?: string | null; closedAt?: string | null }[] = [];
  for (const o of value) {
    if (o !== null && typeof o === 'object' && typeof (o as { side?: unknown }).side === 'string') {
      const intent = (o as { intent?: unknown }).intent;
      const closedAt = (o as { closedAt?: unknown }).closedAt;
      out.push({
        side: (o as { side: string }).side,
        intent: typeof intent === 'string' ? intent : null,
        closedAt: typeof closedAt === 'string' ? closedAt : null,
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
 * How well a stored fee figure is known. `exact` means every commission was valued from evidence dated to the fill itself; `estimated` means a real charge was reconstructed from a source that is not dated to it (a rate table or a ticker read later), so the figure has a basis but no way left to check it; `unknown` means at least one charge is missing outright, so the recorded total under-states what was actually paid.
 *
 * The three are not degrees of confidence in one number, they are three different situations, and the middle one is why a boolean could not carry this: a reconstruction is neither a proof nor an absence, and collapsing it either way tells the operator something false. Collapsed up, an estimate renders as a certified Net P/L; collapsed down, a usable figure is withheld along with every statistic derived from it.
 *
 * `unknown` is the one that biases: a missing charge only ever makes the result look better than it was, so a profit factor rendered off it flatters. That is why the display gate withholds the fee-sensitive statistics there and merely marks them at `estimated`.
 *
 * Text with a named CHECK at the database boundary rather than a native enum, matching {@link SymbolSource}: a native enum gains a value only through its own migration, and `alter type ... add value` cannot run in the same transaction as the rows that would use it.
 */
export const FeeBasis = z.enum(['exact', 'estimated', 'unknown']);
/** TS type derived from {@link FeeBasis} so consumers don't re-run z.infer at every call site. */
export type FeeBasis = z.infer<typeof FeeBasis>;

/**
 * Trust ordering: `unknown` < `estimated` < `exact`. Not an opinion about how close each is to the truth, but a statement about which one a set of rows must be reported as, and the order runs this way because the weakest member is what a reader has to be told about.
 */
const FEE_BASIS_RANK: Record<string, number> = { unknown: 0, estimated: 1, exact: 2 };

/** The tiers by rank, so the fold can return a canonical spelling rather than whichever string it was handed. Index positions must match the ranks above. */
const FEE_BASIS_BY_RANK: readonly FeeBasis[] = ['unknown', 'estimated', 'exact'];

/**
 * Combine two fee tiers into the one a bucket holding both must report: the WEAKER of the pair.
 *
 * A rollup is a single claim about a set of cycles, so it inherits the worst evidence any member carries. Taking the stronger tier would let one proven cycle certify a bucket whose other rows were never valued, which is the direction that flatters — and the direction nothing downstream could detect, because the bucket arrives as one row with one tier.
 *
 * This is the single TS fold; the SQL aggregates use the same ranking inline because a per-row function call in an aggregate is not something Postgres can plan around. An unrecognised value ranks as `unknown` rather than throwing: a tier is read back off a database column and out of a wire payload, and a read path that dies on an unexpected string takes the whole rollup with it when the safe answer is right there.
 *
 * @param a - One tier, from a row or from the fold so far.
 * @param b - The other tier.
 * @returns Whichever of the two is weaker, or `'unknown'` if either is a value this build does not recognise.
 */
export function weakestFeeBasis(a: string, b: string): FeeBasis {
  const rankA = FEE_BASIS_RANK[a] ?? 0;
  const rankB = FEE_BASIS_RANK[b] ?? 0;
  // Map the rank back to a canonical tier rather than returning the input verbatim. An unrecognised string ranks lowest but is not itself a tier, and every consumer gates by equality against the three known spellings, so passing it through would satisfy neither the `=== 'unknown'` withholding branch nor the `=== 'estimated'` marker and render as fully proven. The SQL fold already normalises this way; returning the input is the one input on which the two halves would disagree.
  return FEE_BASIS_BY_RANK[Math.min(rankA, rankB)] as FeeBasis;
}

/**
 * Per-bucket realized-P/L primitives shared by the by-intent and by-source rollups. `profitSum` is the signed Recorded cost-basis result; `totalFees` is the additional quote adjustment, so Net = `profitSum - totalFees`.
 *
 * `wins`/`losses` and `grossProfit`/`grossLoss` classify the known Net subtotal; `feeBasis` says how well that subtotal's fee component is known and therefore how far those statistics can be trusted. The wire carries decimal sums and integer counts, never divided money values. A zero subtotal counts in `tradeCount` but in neither `wins` nor `losses`.
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
  feeBasis: FeeBasis.default('unknown'),
} as const;

/** One period-scoped P/L bucket grouped by `(quoteAsset, exitIntent)`. */
export const ByIntentRollupSchema = z.object({
  quoteAsset: z.string(),
  intent: z.string(),
  ...rollupMetricFields,
});
/** TS type derived from {@link ByIntentRollupSchema}. */
export type ByIntentRollup = z.infer<typeof ByIntentRollupSchema>;

/** One period-scoped P/L bucket grouped by `(quoteAsset, source)` (auto = discovery found it, manual = the operator added it, unknown = the bot re-created it to recover an untracked position). */
export const BySourceRollupSchema = z.object({
  quoteAsset: z.string(),
  source: z.string(),
  ...rollupMetricFields,
});
/** TS type derived from {@link BySourceRollupSchema}. */
export type BySourceRollup = z.infer<typeof BySourceRollupSchema>;

/**
 * One period row fed to the archive rollups: its quote, source, Recorded result, additional fee adjustment, fee tier, and orders. An absent `feeBasis` reads as `unknown`, so an older producer stays parseable without its Net result being promoted.
 */
export interface ArchiveRollupItem {
  readonly quoteAsset: string;
  readonly source: string;
  readonly profit: string;
  readonly feesQuote?: string;
  readonly feeBasis?: string;
  // `closedAt` is what {@link deriveExitIntent} orders by; a projection that annotates itself with this type and drops the field silently falls back to position-based selection.
  readonly orders: readonly { side: string; intent?: string | null; closedAt?: string | null }[];
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
  feeBasis: FeeBasis;
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
        // Seeded at the STRONGEST tier so the fold below can only ever weaken it. An empty bucket is one nothing is wrong with, which is the reading `coalesce(bool_and(...), true)` already had on the SQL side.
        feeBasis: 'exact' as FeeBasis,
      };
      buckets.set(key, b);
    }
    b.tradeCount += 1;
    // Win/loss and the gross winner/loser magnitudes are classified on Net = Recorded profit - the additional fee adjustment.
    b.profitSum = decimalAdd(b.profitSum, item.profit);
    const feesQuote = item.feesQuote ?? '0';
    b.feeBasis = weakestFeeBasis(b.feeBasis, item.feeBasis ?? 'unknown');
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
  feeBasis: FeeBasis;
} {
  return {
    quoteAsset: b.quoteAsset,
    tradeCount: b.tradeCount,
    wins: b.wins,
    losses: b.losses,
    profitSum: asDecimalString(b.profitSum),
    // Net = Recorded result minus the additional fee adjustment.
    netProfit: asDecimalString(new Decimal(b.profitSum).sub(b.totalFees)),
    grossProfit: asDecimalString(b.grossProfit),
    grossLoss: asDecimalString(b.grossLoss),
    totalFees: asDecimalString(b.totalFees),
    feeBasis: b.feeBasis,
  };
}

/**
 * Group archived trades by `(quoteAsset, exitIntent)`. The exit intent is derived per row via {@link deriveExitIntent} (the intent of the SELL that closed the cycle, i.e. the one with the greatest `closedAt`), so callers pass the raw archived `orders` and the rollup owns the derivation.
 */
export function rollupByExitIntent(items: readonly ArchiveRollupItem[]): ByIntentRollup[] {
  return accumulateBuckets(items, (item) => deriveExitIntent(item.orders)).map((b) => ({
    ...bucketMetrics(b),
    intent: b.dimension,
  }));
}

/** Group archived trades by `(quoteAsset, source)` so the operator sees which origin — discovery, operator-added, or bot-recovered — carries the edge. */
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
  readonly feeBasis: FeeBasis;
}

const EMPTY_CLOSED_TRADES_SUMMARY: ClosedTradesSummary = {
  tradeCount: 0,
  wins: 0,
  losses: 0,
  grossProfit: '0',
  grossLoss: '0',
  netProfit: '0',
  totalFees: '0',
  feeBasis: 'exact',
};

/**
 * Collapse a profile's closed trades into one summary, ignoring the quote/source partition. The known Net subtotal uses the same classification as the rollups, and `feeBasis` tells consumers how far those statistics can be trusted. Empty input yields the all-zero summary at the strongest tier: there is nothing there to distrust.
 *
 * @param items - Archive rows whose known fee adjustments should be combined.
 * @returns The combined known subtotal, classification fields, and the weakest fee tier any row carried.
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
    feeBasis: m.feeBasis,
  };
}

/**
 * Closed-trade archive row for one buy/sell cycle. `profit` is the strategy-agnostic Recorded cost-basis result and may already include a base-asset BUY fee through fee-net quantity. `breakdown` maps `"<intent>:<side>"` to its quote total so the UI can show a strategy-owned split without re-aggregating orders.
 */
export const TradeArchiveResponse = z.object({
  id: z.uuid(),
  symbol: z.string(),
  baseAsset: z.string(),
  quoteAsset: z.string(),
  totalBuyQuote: DecimalString,
  totalSellQuote: DecimalString,
  breakdown: z.record(z.string(), DecimalString),
  // Binance commissions for the cycle, summed per asset. Empty when trade history was unavailable at archive time.
  fees: z.record(z.string(), DecimalString),
  // Known quote-currency adjustment not already included in `profit`. The scalar default keeps older producers parseable; the tier beside it defaults to `unknown` so a zero is never promoted to an exact Net without evidence.
  feesQuote: DecimalString.default(asDecimalString('0')),
  // How well `feesQuote` is known. Defaulted to the weakest tier so a payload from an older producer, which says nothing about its fee evidence, is never promoted to a certified Net P/L on that silence.
  feeBasis: FeeBasis.default('unknown'),
  // `profit - feesQuote`, server-computed and trustworthy only as far as `feeBasis` says. The default keeps older producers parseable.
  netProfit: DecimalString.default(asDecimalString('0')),
  profit: DecimalString,
  // Why the cycle closed: the intent of the SELL that closed it, i.e. the one with the greatest `closedAt`, derived at read time from the archived `orders` (no stored column). `'unknown'` for rows with no SELL or a missing intent (e.g. backfilled history). `.default` keeps pre-existing response producers/consumers from breaking.
  exitIntent: z.string().default('unknown'),
  // How many SELLs had no cost basis. A positive count makes both P/L bases unavailable because their numeric subtotal is an under-count. The default preserves the earlier wire shape.
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
 * Profile-level archive response, in one of two shapes selected by the request's `view`.
 *
 * Under `view=full` (the default) every field below is present. Under `view=rollup` the server runs only the read that feeds `byIntent` and `bySource`, and the four fields the other reads would have filled are OMITTED — `items`, `nextCursor`, `recoverableSymbols`, `unreconstructableSymbols`. That is why they are optional here rather than defaulted, the same shape `SaveDiagnostics` uses for the same reason: the field's ABSENCE is the signal, and a default would manufacture an answer out of silence.
 *
 * A consumer must branch on that absence and must never default it. Each of the four has a value that reads as a positive claim the rollup response never checked: `[]` for `items` says the window holds no trades, `null` for `nextCursor` says end-of-stream, `[]` for `recoverableSymbols` says every coin is accounted for — which is what ends a running recovery — and `[]` for `unreconstructableSymbols` says nothing failed to rebuild. `byIntent` and `bySource` keep their `.default([])` because the rollup read always runs, so an empty array there genuinely means "no trades in this window".
 *
 * `nextCursor` is opaque when present: the composite `<archivedAt-iso>__<id>` the route emits, so a same-timestamp group is paged stably. The client treats it as a string and echoes it back via `?cursor=`, and it is null when the page came up shorter than the requested limit.
 */
export const ProfileArchiveListResponse = z.object({
  // Optional and omitted, never `[]` or `null`, on a response that did not page the archive — the same shape `SaveDiagnostics` uses, and for the same reason: the field's ABSENCE is itself the signal. `[]` says "the archive holds no trades in this window", which a rollup-only response has no basis to claim.
  items: z.array(TradeArchiveResponse).optional(),
  nextCursor: z.string().nullable().optional(),
  // Coins with fills, no archive row, and not yet backfilled — the actionable
  // "may have unsaved P/L, recover it" set. Drives the recover-all nudge.
  // Absent means the response never computed the set; `[]` means it did and every
  // coin is accounted for. Only the second may end a running recovery, so the two
  // cannot collapse into one value.
  recoverableSymbols: z.array(z.string()).optional(),
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
    .optional(),
  // Period-scoped P/L grouped by exit intent over EVERY trade in the selected
  // period (not just the visible page), so the operator sees which exit reason
  // is winning or bleeding across the whole window. `.default([])` keeps older
  // producers valid.
  byIntent: z.array(ByIntentRollupSchema).default([]),
  // Same period-scoped rollup grouped by where the binding came from (auto = discovery found it, manual = the operator added it, unknown = the bot re-created it to recover an untracked position) so the operator sees which origin is the edge or the drag. Provenance only: a pin does not move a trade between buckets. `.default([])` keeps older producers valid.
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
