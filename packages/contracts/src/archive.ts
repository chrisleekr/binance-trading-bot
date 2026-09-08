import Decimal from 'decimal.js';
import { z } from 'zod';
import { asDecimalString, DecimalString, decimalAdd } from './decimal.js';

/**
 * The stored stamp when it is the ISO-8601 instant the wire declares, else null.
 *
 * `Date.parse` is deliberately not the test. It accepts spellings this schema rejects, `'2026-05-09'` and `'Mon, 09 May 2026'` among them, and every value screened here is returned VERBATIM into a response field typed `z.iso.datetime()`. Nothing validates a response body at runtime, so a legacy or hand-repaired row written in one of those spellings ships a field the contract says is an ISO instant and is not, and the client parses it under whatever its own engine makes of it.
 */
const ISO_INSTANT = z.iso.datetime();
const isoInstant = (value: string | null | undefined): string | null =>
  value != null && ISO_INSTANT.safeParse(value).success ? value : null;

/**
 * The exit intent of one archived buy/sell cycle: the `intent` of the SELL that closed it, i.e. the one with the greatest `closedAt`. The closing SELL is what actually realized the cycle's P/L, so its intent (e.g. `grid-stop-loss`, `technicals-force-sell`, `grid-sell`, `manual`) is the honest "why did this trade close" label. A cycle with no SELL, or a SELL whose intent is missing, is `'unknown'` so recovered/backfilled rows read truthfully rather than being dropped.
 *
 * Selection is by timestamp, never by array position, because no writer guarantees a chronological array and the two disagree: the forward archive emits `desc(closedAt)` so its LAST SELL is the cycle's FIRST exit, and the backfill emits Map-insertion order keyed on each order's FIRST fill, so an order that partially fills, yields to a second SELL, then flattens the position lands before that second SELL. Reading by position picked the wrong SELL in both, which mislabels every cycle closed by more than one SELL and mis-buckets the by-exit-reason rollup that shares this function.
 *
 * Rows written before `closedAt` was carried, or whose stamps are not the ISO instant the wire declares, keep the previous last-in-array behaviour: with nothing to order by, position is the only signal left.
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
    // The same screen {@link deriveExitAt} ranks on, so ONE definition of a readable stamp decides both. A bare `Date.parse` accepts spellings that screen rejects, and a SELL ranked here on such a stamp but skipped there gives the cycle an exit REASON off one order and an exit TIME off another, which is the pairing both callers document.
    const closedAt = isoInstant(order.closedAt);
    if (closedAt === null) {
      // Rows with no readable stamp only compete with each other, and the last one wins, which is the legacy behaviour. One stamped SELL retires them all.
      if (closingAt === -Infinity) closing = order;
      continue;
    }
    const at = Date.parse(closedAt);
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
 * When the cycle was opened: the EARLIEST `closedAt` on a BUY.
 *
 * By timestamp and never by array position, for the reason {@link deriveExitIntent} documents at length: no writer guarantees a chronological array, and the two disagree in both directions. Null when no BUY carries a stamp, which is the honest answer for a backfilled cycle whose reconstructed orders have none — a caller must render that as unknown rather than as a zero-length hold, which would read as a trade that opened and closed in the same instant.
 *
 * @param orders - Archived order summaries of one cycle, in any order.
 * @returns The opening instant as its stored ISO string, or null when no BUY is stamped.
 */
export function deriveEntryAt(
  orders: readonly { side: string; closedAt?: string | null }[],
): string | null {
  return extremeAt(orders, 'BUY', 'earliest');
}

/**
 * When the cycle was closed: the LATEST `closedAt` on a SELL, i.e. the fill that realized the P/L.
 *
 * The same selection {@link deriveExitIntent} makes for the intent, so the reported exit time and the reported exit reason always come off the same order.
 *
 * @param orders - Archived order summaries of one cycle, in any order.
 * @returns The closing instant as its stored ISO string, or null when no SELL is stamped.
 */
export function deriveExitAt(
  orders: readonly { side: string; closedAt?: string | null }[],
): string | null {
  return extremeAt(orders, 'SELL', 'latest');
}

/** The earliest or latest ISO `closedAt` among the orders on one side, returned verbatim so the caller keeps the stored spelling rather than a re-serialised one. */
function extremeAt(
  orders: readonly { side: string; closedAt?: string | null }[],
  side: 'BUY' | 'SELL',
  pick: 'earliest' | 'latest',
): string | null {
  let best: string | null = null;
  let bestAt = pick === 'earliest' ? Infinity : -Infinity;
  for (const order of orders) {
    if (order.side !== side) continue;
    // Screened before it is ordered by, not after: a stamp that is not an instant is not a time, and one this function would emit is also a contract violation at the caller's response boundary.
    const closedAt = isoInstant(order.closedAt);
    if (closedAt === null) continue;
    const at = Date.parse(closedAt);
    if (pick === 'earliest' ? at < bestAt : at > bestAt) {
      best = closedAt;
      bestAt = at;
    }
  }
  return best;
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
  netTradeCount: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  profitSum: DecimalString,
  netProfit: DecimalString,
  grossProfit: DecimalString,
  grossLoss: DecimalString,
  totalFees: DecimalString,
  feeBasis: FeeBasis.default('unknown'),
  // Mean holding period in milliseconds over the cycles that carry both an entry and an exit stamp, or null when none does. Milliseconds and not a formatted string because the reader renders it at its own scale, and nullable because a backfilled cycle with no BUY stamp has no duration at all — a zero there would read as a trade that opened and closed in the same instant.
  avgHoldMs: z.number().nonnegative().nullable().default(null),
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
  /** Every row. Denominator for `profitSum` and the Recorded basis. */
  tradeCount: number;
  /** Rows whose `feeBasis` is not `unknown`. Denominator for every Net-derived figure below it. */
  netTradeCount: number;
  wins: number;
  losses: number;
  /** Recorded result over all `tradeCount` rows. An unvalued row still has a real cost-basis P/L, so excluding it here would withhold a figure its evidence fully supports. */
  profitSum: string;
  /** Recorded result over the `netTradeCount` valued rows only, so `netProfit` subtracts fees from the same rows those fees came off. Summing `totalFees` out of the whole-bucket `profitSum` would charge the valued rows' fees against the unvalued rows' profit. */
  netProfitSum: string;
  grossProfit: string;
  grossLoss: string;
  totalFees: string;
  /** Weakest tier among the VALUED rows only. `unknown` now means exactly one thing: nothing in this bucket could be valued at all. */
  feeBasis: FeeBasis;
  /** Total holding time of the cycles that could be timed, and how many those were. Their own denominator, because a cycle with no entry stamp is not a zero-length hold, it is one nobody can time. */
  holdMsSum: number;
  holdCount: number;
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
        netTradeCount: 0,
        wins: 0,
        losses: 0,
        profitSum: '0',
        netProfitSum: '0',
        grossProfit: '0',
        grossLoss: '0',
        totalFees: '0',
        holdMsSum: 0,
        holdCount: 0,
        // Seeded at the STRONGEST tier so the fold below can only ever weaken it, and now only by rows that cleared the valued gate, so it can no longer reach `unknown` while a real Net figure stands beside it. A bucket that valued nothing reports `unknown` at projection time instead.
        feeBasis: 'exact' as FeeBasis,
      };
      buckets.set(key, b);
    }
    b.tradeCount += 1;
    b.profitSum = decimalAdd(b.profitSum, item.profit);
    // Timed on the Recorded leg, not the Net one: how long a cycle was held is a fact about the orders, which the fee evidence has nothing to do with.
    const holdMs = holdMsOf(item.orders);
    if (holdMs !== null) {
      b.holdMsSum += holdMs;
      b.holdCount += 1;
    }

    // Canonicalised through the same fold the bucket's tier uses, so a tier this build does not recognise reads as unvalued rather than as evidence. `netTradeCount === 0` and a reported `unknown` tier then mean exactly one thing between them, and the SQL half agrees, whose rank expression maps any unrecognised value to NULL.
    const rowBasis = weakestFeeBasis(item.feeBasis ?? 'unknown', 'exact');
    // An `unknown` row contributes to the Recorded leg and to nothing else. Its fee is missing outright, so folding it into `totalFees`, into the win/loss split, or into the tier would each corrupt a different Net statistic, and the previous fold did all three at once by weakening the whole bucket to `unknown` and charging the valued rows' fees against this row's profit.
    if (rowBasis === 'unknown') continue;

    // Win/loss and the gross winner/loser magnitudes are classified on Net = Recorded profit - the additional fee adjustment, over the valued rows alone so every Net statistic shares one denominator.
    const feesQuote = item.feesQuote ?? '0';
    b.netTradeCount += 1;
    b.netProfitSum = decimalAdd(b.netProfitSum, item.profit);
    b.feeBasis = weakestFeeBasis(b.feeBasis, rowBasis);
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

/**
 * How long a cycle was held, from its two derived stamps.
 *
 * The one negative-span rule every surface shares. A negative span means the two stamps came from orders that cannot both belong to this cycle, and it must read as unstamped rather than as a duration: dropped here, a bad row sorts to the end of either direction and renders an em dash, while a negative number sorts FIRST under an ascending hold sort and renders as the shortest hold in the list. `null` also stays distinct from `0`, because a zero-length hold is a claim that a cycle opened and closed in the same instant.
 *
 * @param entryAt - The cycle's opening instant as an ISO string, or null when no buy in it is stamped.
 * @param exitAt - The cycle's closing instant as an ISO string, or null when no sell in it is stamped.
 * @returns Elapsed milliseconds, or null when either end is unstamped or the span is unusable.
 */
export function holdMsBetween(entryAt: string | null, exitAt: string | null): number | null {
  if (entryAt === null || exitAt === null) return null;
  const ms = Date.parse(exitAt) - Date.parse(entryAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** How long one cycle was held off its orders, or null when either end is unstamped. Delegates the span rule to {@link holdMsBetween} so the rollup's average and the row's own Held column cannot disagree about what a negative span means. */
function holdMsOf(orders: readonly { side: string; closedAt?: string | null }[]): number | null {
  return holdMsBetween(deriveEntryAt(orders), deriveExitAt(orders));
}

/**
 * The shared decimal-string projection of one accumulated bucket: everything the wire carries except the dimension label, which only the caller knows the name of.
 *
 * One projection for both rollups, because the by-exit-reason and by-source bands partition the SAME cycles and a reader compares them against each other; two projections drifting apart is how a bucket comes to mean something different in the band beside it.
 *
 * @param b - The accumulated bucket: raw running totals, with `netTradeCount` counting only the rows whose fees could be read and `holdCount` only the ones that could be timed.
 * @returns The bucket as the wire carries it. Every money field is a decimal STRING, and three fields are deliberately not the obvious read of their accumulator — `netProfit` is the valued rows' result net of their own fees and is meaningless unless `netTradeCount` is above zero, `feeBasis` reports `unknown` rather than the `exact` seed when nothing was valued, and `avgHoldMs` is null rather than zero when nothing could be timed.
 */
function bucketMetrics(b: RollupBucket): {
  quoteAsset: string;
  tradeCount: number;
  netTradeCount: number;
  wins: number;
  losses: number;
  profitSum: DecimalString;
  netProfit: DecimalString;
  grossProfit: DecimalString;
  grossLoss: DecimalString;
  totalFees: DecimalString;
  feeBasis: FeeBasis;
  avgHoldMs: number | null;
} {
  return {
    quoteAsset: b.quoteAsset,
    tradeCount: b.tradeCount,
    netTradeCount: b.netTradeCount,
    wins: b.wins,
    losses: b.losses,
    profitSum: asDecimalString(b.profitSum),
    // Net = the VALUED rows' Recorded result minus their own fees. Zero when nothing was valued, which is why `netTradeCount`, not this number, is what decides whether a caller may render it.
    netProfit: asDecimalString(new Decimal(b.netProfitSum).sub(b.totalFees)),
    grossProfit: asDecimalString(b.grossProfit),
    grossLoss: asDecimalString(b.grossLoss),
    totalFees: asDecimalString(b.totalFees),
    // A bucket with no valued rows reports `unknown` rather than the `exact` seed: both mean nothing was read, but here the caller must be able to tell "nothing to distrust" from "nothing to trust".
    feeBasis: b.netTradeCount === 0 ? 'unknown' : b.feeBasis,
    // Null, never zero, when nothing in the bucket could be timed.
    avgHoldMs: b.holdCount === 0 ? null : b.holdMsSum / b.holdCount,
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
  /** Rows carrying fee evidence: the denominator of `netProfit`, `totalFees` and the win/loss split beside it. */
  readonly netTradeCount: number;
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
  netTradeCount: 0,
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
    netTradeCount: m.netTradeCount,
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
  // When the cycle opened and closed, derived server-side from the archived `orders` the same way `exitIntent` is, so the browser never sees the raw Binance payload those stamps come from. Null when the stored orders carry no stamp on that side, which is a real state for a backfilled cycle and must render as unknown rather than as a hold of zero.
  entryAt: z.iso.datetime().nullable().default(null),
  exitAt: z.iso.datetime().nullable().default(null),
  // How many SELLs had no cost basis. A positive count makes both P/L bases unavailable because their numeric subtotal is an under-count. The default preserves the earlier wire shape.
  missingCostBasis: z.number().int().nonnegative().default(0),
  archivedAt: z.iso.datetime(),
});
/** TS type derived from {@link TradeArchiveResponse} so consumers don't re-run z.infer at every call site. */
export type TradeArchiveResponse = z.infer<typeof TradeArchiveResponse>;

/**
 * One order of an archived cycle, as the detail sheet states it.
 *
 * A projection of the stored summary, not the summary itself: each stored element embeds the whole raw Binance order payload, which is why the list ships no `orders` at all and why this drops `raw` and the strategy-owned `meta`. What is left is what an operator auditing a cycle needs — which side, why, whether it filled, for how much, and when.
 */
export const ArchivedOrderDetail = z.object({
  orderId: z.string(),
  // Binance's id as a decimal string. It is a 64-bit integer, so it does not survive a JSON number.
  binanceOrderId: z.string(),
  clientOrderId: z.string(),
  intent: z.string(),
  // Null on a row whose stored side was neither BUY nor SELL — unreachable for a live archive, real for a hand-repaired one.
  side: z.enum(['BUY', 'SELL']).nullable(),
  status: z.string(),
  // Execution totals off the exchange snapshot, null when the archive was written without one. Not defaulted to '0': an unproven fill is not an empty fill.
  executedQty: DecimalString.nullable(),
  cummulativeQuoteQty: DecimalString.nullable(),
  closedAt: z.iso.datetime().nullable(),
});
/** TS type derived from {@link ArchivedOrderDetail} so consumers don't re-run z.infer at every call site. */
export type ArchivedOrderDetail = z.infer<typeof ArchivedOrderDetail>;

/**
 * The fills behind one archived cycle, fetched when its sheet opens.
 *
 * Progressive disclosure at the API layer. The list carries every scalar the ledger renders and none of the orders; this carries the orders and nothing else, so the cost of the payload is paid once, by the one row the operator actually opened.
 */
export const TradeArchiveDetailResponse = z.object({
  id: z.uuid(),
  orders: z.array(ArchivedOrderDetail),
});
/** TS type derived from {@link TradeArchiveDetailResponse} so consumers don't re-run z.infer at every call site. */
export type TradeArchiveDetailResponse = z.infer<typeof TradeArchiveDetailResponse>;

/**
 * Read the stored `orders` jsonb into the detail projection, dropping anything that does not carry the fields the sheet states.
 *
 * Defensive in the same way {@link coerceArchivedOrders} is, and for the same reason: the column is jsonb written by two different producers across the archive's history, so a row can legitimately hold an element this shape cannot describe. Such an element is dropped rather than rendered half-formed — a fill the sheet cannot state is better absent than shown with blank facts an operator would read as proven zeros.
 *
 * @param value - The stored `orders` jsonb, in whatever shape the row actually holds.
 * @returns Every element that carried a string `orderId` and `side`, projected to the wire shape; `[]` for anything else.
 */
export function coerceArchivedOrderDetails(value: unknown): ArchivedOrderDetail[] {
  if (!Array.isArray(value)) return [];
  const out: ArchivedOrderDetail[] = [];
  for (const o of value) {
    if (o === null || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    if (typeof r['orderId'] !== 'string') continue;
    const str = (k: string): string | null => (typeof r[k] === 'string' ? (r[k] as string) : null);
    const side = str('side');
    // Parsed through the wire schema, never cast into it: the column holds whatever its producer wrote, and a value that is not a well-formed decimal has to become `null` here — casting it would ship a field the response's own contract says is a decimal and is not.
    const decimalOrNull = (k: string): ArchivedOrderDetail['executedQty'] => {
      const parsed = DecimalString.safeParse(r[k]);
      return parsed.success ? parsed.data : null;
    };
    out.push({
      orderId: r['orderId'],
      binanceOrderId: str('binanceOrderId') ?? '',
      clientOrderId: str('clientOrderId') ?? '',
      intent: str('intent') ?? 'unknown',
      side: side === 'BUY' || side === 'SELL' ? side : null,
      status: str('status') ?? 'UNKNOWN',
      executedQty: decimalOrNull('executedQty'),
      cummulativeQuoteQty: decimalOrNull('cummulativeQuoteQty'),
      // Screened, not merely read as a string: this lands in a field the detail response types `z.iso.datetime()`, and the column holds whatever its producer wrote.
      closedAt: isoInstant(str('closedAt')),
    });
  }
  return out;
}

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

/**
 * Keys the archive list can be ordered by.
 *
 * Declared here, not in the route, because the query string is a contract: the SPA builds the value and the API validates it, and a key that exists on only one side is a silent fallback to the default ordering rather than an error the operator can see.
 */
export const ArchiveSort = z.enum(['archivedAt', 'netProfit', 'profit', 'holdMs', 'symbol']);
/** TS type derived from {@link ArchiveSort} so consumers don't re-run z.infer at every call site. */
export type ArchiveSort = z.infer<typeof ArchiveSort>;

/** Direction for {@link ArchiveSort}. */
export const ArchiveSortDir = z.enum(['asc', 'desc']);
/** TS type derived from {@link ArchiveSortDir} so consumers don't re-run z.infer at every call site. */
export type ArchiveSortDir = z.infer<typeof ArchiveSortDir>;
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
  // The window the rollups were taken over, resolved server-side and echoed back the way {@link ClosedTradesResponse} echoes its own. The period tokens are cut in the operator's timezone, and a second surface that plots the same window — the History curve and the operator actions on it — must plot the window the numbers came from rather than re-derive it from the same token and drift by a day at a boundary.
  from: z.iso.datetime(),
  to: z.iso.datetime(),
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
