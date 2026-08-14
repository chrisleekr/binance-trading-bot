import { and, desc, eq, gt, gte, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import type { SymbolSource } from '@app/contracts';
import { appliedFills } from '../schema/applied-fills.js';
import { backfillAttempts } from '../schema/backfill-attempts.js';
import { orders, type OrderRow } from '../schema/orders.js';
import {
  tradeArchive,
  type TradeArchiveInsert,
  type TradeArchiveRow,
} from '../schema/trade-archive.js';
import type { ProfileScope } from './_scoped.js';

export async function listForSymbol(
  scope: ProfileScope,
  symbol: string,
  limit: number,
): Promise<TradeArchiveRow[]> {
  return scope.db
    .select()
    .from(tradeArchive)
    .where(and(eq(tradeArchive.profileId, scope.profileId), eq(tradeArchive.symbol, symbol)))
    .orderBy(desc(tradeArchive.archivedAt))
    .limit(limit);
}

export async function listForProfile(
  scope: ProfileScope,
  limit: number,
): Promise<TradeArchiveRow[]> {
  return scope.db
    .select()
    .from(tradeArchive)
    .where(eq(tradeArchive.profileId, scope.profileId))
    .orderBy(desc(tradeArchive.archivedAt))
    .limit(limit);
}

/**
 * Composite cursor for {@link listForProfilePaginated}. The `id` tie-
 * breaker covers rows that share an `archivedAt` timestamp — without it,
 * a page boundary that lands inside a same-timestamp group leaves the
 * remaining rows of that group unreachable on the next page.
 */
export interface TradeArchiveCursor {
  readonly archivedAt: Date;
  readonly id: string;
}

/**
 * Paginated, period-filtered archive reader. Cursor is composite
 * (`archivedAt` + row `id`) so pages are stable when multiple archives
 * land in the same millisecond. `from` is the inclusive lower bound (or
 * `null` for "all time"). Caller decides the period boundary so the repo
 * doesn't have to carry a locale/timezone story — the API layer already
 * owns that for the closed-trades widget.
 */
export async function listForProfilePaginated(
  scope: ProfileScope,
  limit: number,
  from: Date | null,
  cursor: TradeArchiveCursor | null,
): Promise<TradeArchiveRow[]> {
  const conditions = [eq(tradeArchive.profileId, scope.profileId)];
  if (from !== null) conditions.push(gte(tradeArchive.archivedAt, from));
  if (cursor !== null) {
    const tieBreaker = or(
      lt(tradeArchive.archivedAt, cursor.archivedAt),
      and(eq(tradeArchive.archivedAt, cursor.archivedAt), lt(tradeArchive.id, cursor.id)),
    );
    if (tieBreaker !== undefined) conditions.push(tieBreaker);
  }
  return scope.db
    .select()
    .from(tradeArchive)
    .where(and(...conditions))
    .orderBy(desc(tradeArchive.archivedAt), desc(tradeArchive.id))
    .limit(limit);
}

/**
 * Every archive row for the profile in `[from, ∞)` (or all-time when `from`
 * is `null`), projected to just the columns the archive rollups need:
 * `quoteAsset`, `source`, `profit`, and the archived `orders` (the by-intent
 * rollup derives each row's exit intent from the last SELL; the by-source
 * rollup groups on `source`). Unpaginated on purpose: the rollup is
 * period-scoped (the whole window, not the visible page), and a profile's
 * archive is small enough to read in full. The caller owns the period
 * boundary, matching {@link listForProfilePaginated}.
 */
export async function listForProfileInRange(
  scope: ProfileScope,
  from: Date | null,
): Promise<
  {
    quoteAsset: string;
    source: SymbolSource;
    profit: string;
    feesQuote: string;
    orders: unknown;
  }[]
> {
  const conditions = [eq(tradeArchive.profileId, scope.profileId)];
  if (from !== null) conditions.push(gte(tradeArchive.archivedAt, from));
  return scope.db
    .select({
      quoteAsset: tradeArchive.quoteAsset,
      source: tradeArchive.source,
      profit: tradeArchive.profit,
      feesQuote: tradeArchive.feesQuote,
      orders: tradeArchive.orders,
    })
    .from(tradeArchive)
    .where(and(...conditions));
}

/**
 * Period totals for the closed-trades widget. `totalProfitPercent` is the
 * summed profit over the summed buy-quote cost basis; it is computed in SQL
 * (numeric, arbitrary-precision) to keep money math out of JS, matching
 * {@link summarizeArchiveSince}. A zero cost basis (no rows in range) yields
 * a `'0'` percent rather than a divide-by-zero.
 */
export async function sumProfitInRange(
  scope: ProfileScope,
  from: Date,
  to: Date,
): Promise<{
  totalProfit: string;
  totalProfitPercent: string;
  totalFees: string;
  netProfit: string;
  tradeCount: number;
}> {
  const rows = await scope.db
    .select({
      totalProfit: sql<string>`coalesce(sum(${tradeArchive.profit}), 0)::text`,
      totalProfitPercent: sql<string>`case
        when coalesce(sum(${tradeArchive.totalBuyQuote}), 0) = 0 then '0'
        else round(coalesce(sum(${tradeArchive.profit}), 0)
              / sum(${tradeArchive.totalBuyQuote}) * 100, 8)::text end`,
      totalFees: sql<string>`coalesce(sum(${tradeArchive.feesQuote}), 0)::text`,
      netProfit: sql<string>`coalesce(sum(${tradeArchive.profit} - ${tradeArchive.feesQuote}), 0)::text`,
      tradeCount: sql<number>`count(*)::int`,
    })
    .from(tradeArchive)
    .where(
      and(
        eq(tradeArchive.profileId, scope.profileId),
        gte(tradeArchive.archivedAt, from),
        lt(tradeArchive.archivedAt, to),
      ),
    );
  return {
    totalProfit: rows[0]?.totalProfit ?? '0',
    totalProfitPercent: rows[0]?.totalProfitPercent ?? '0',
    totalFees: rows[0]?.totalFees ?? '0',
    netProfit: rows[0]?.netProfit ?? '0',
    tradeCount: rows[0]?.tradeCount ?? 0,
  };
}

/**
 * Same aggregate as {@link sumProfitInRange}, narrowed to one symbol-source.
 * The discovery net-edge scoreboard sums realized PnL + win rate over
 * `source='auto'` archives so the operator sees discovery-attributed results
 * isolated from manual trading. `wins` counts archives with positive NET-of-fee
 * profit; `totalFees`/`netProfit` carry the fee-adjusted totals.
 */
export async function sumProfitInRangeForSource(
  scope: ProfileScope,
  from: Date,
  to: Date,
  source: SymbolSource,
): Promise<{
  totalProfit: string;
  totalProfitPercent: string;
  totalFees: string;
  netProfit: string;
  tradeCount: number;
  wins: number;
}> {
  const rows = await scope.db
    .select({
      totalProfit: sql<string>`coalesce(sum(${tradeArchive.profit}), 0)::text`,
      totalProfitPercent: sql<string>`case
        when coalesce(sum(${tradeArchive.totalBuyQuote}), 0) = 0 then '0'
        else round(coalesce(sum(${tradeArchive.profit}), 0)
              / sum(${tradeArchive.totalBuyQuote}) * 100, 8)::text end`,
      totalFees: sql<string>`coalesce(sum(${tradeArchive.feesQuote}), 0)::text`,
      netProfit: sql<string>`coalesce(sum(${tradeArchive.profit} - ${tradeArchive.feesQuote}), 0)::text`,
      tradeCount: sql<number>`count(*)::int`,
      // Win = net-of-fee profit > 0. A trade that cleared a gross profit but not
      // its fees is a net loss, so it must not count as a win.
      wins: sql<number>`count(*) filter (where ${tradeArchive.profit} - ${tradeArchive.feesQuote} > 0)::int`,
    })
    .from(tradeArchive)
    .where(
      and(
        eq(tradeArchive.profileId, scope.profileId),
        eq(tradeArchive.source, source),
        gte(tradeArchive.archivedAt, from),
        lt(tradeArchive.archivedAt, to),
      ),
    );
  return {
    totalProfit: rows[0]?.totalProfit ?? '0',
    totalProfitPercent: rows[0]?.totalProfitPercent ?? '0',
    totalFees: rows[0]?.totalFees ?? '0',
    netProfit: rows[0]?.netProfit ?? '0',
    tradeCount: rows[0]?.tradeCount ?? 0,
    wins: rows[0]?.wins ?? 0,
  };
}

/**
 * Same period aggregate as {@link sumProfitInRange}, split per symbol-source in
 * one `GROUP BY source` pass. Backs the Home scoreboard's by-source band: the
 * operator sees discovery (auto) vs manual side by side, each with the win/loss
 * counts and gross win/loss magnitudes the UI turns into win% and profit factor.
 * `wins`/`losses` count strictly-positive/strictly-negative NET-of-fee archives
 * (breakeven counts toward `tradeCount` only); `grossProfit`/`grossLoss` are the
 * summed net winners and the absolute summed net losers, both kept as decimal
 * strings so no money value crosses into JS floats. `totalProfit` is gross (for
 * the UI's gross↔net toggle); `netProfit`/`totalFees` are the fee-adjusted view.
 * Ordered by source for a deterministic band.
 */
export async function sumProfitInRangeBySource(
  scope: ProfileScope,
  from: Date,
  to: Date,
): Promise<
  {
    source: SymbolSource;
    totalProfit: string;
    totalProfitPercent: string;
    totalFees: string;
    netProfit: string;
    tradeCount: number;
    wins: number;
    losses: number;
    grossProfit: string;
    grossLoss: string;
  }[]
> {
  // Win/loss split and the gross winner/loser magnitudes are computed on
  // net-of-fee profit (`profit - fees_quote`) so win% and profit factor reflect
  // what was actually kept. `totalProfit` stays gross (the UI offers a
  // gross↔net toggle); `netProfit`/`totalFees` carry the fee-adjusted view.
  const net = sql`(${tradeArchive.profit} - ${tradeArchive.feesQuote})`;
  return scope.db
    .select({
      source: tradeArchive.source,
      totalProfit: sql<string>`coalesce(sum(${tradeArchive.profit}), 0)::text`,
      totalProfitPercent: sql<string>`case
        when coalesce(sum(${tradeArchive.totalBuyQuote}), 0) = 0 then '0'
        else round(coalesce(sum(${tradeArchive.profit}), 0)
              / sum(${tradeArchive.totalBuyQuote}) * 100, 8)::text end`,
      totalFees: sql<string>`coalesce(sum(${tradeArchive.feesQuote}), 0)::text`,
      netProfit: sql<string>`coalesce(sum(${net}), 0)::text`,
      tradeCount: sql<number>`count(*)::int`,
      // Classified on ${net} (= profit − fees_quote), NOT raw profit: a gross win
      // that did not clear its fees is a net loss. Do not revert these to `profit`.
      wins: sql<number>`count(*) filter (where ${net} > 0)::int`,
      losses: sql<number>`count(*) filter (where ${net} < 0)::int`,
      grossProfit: sql<string>`coalesce(sum(${net}) filter (where ${net} > 0), 0)::text`,
      grossLoss: sql<string>`coalesce(abs(sum(${net}) filter (where ${net} < 0)), 0)::text`,
    })
    .from(tradeArchive)
    .where(
      and(
        eq(tradeArchive.profileId, scope.profileId),
        gte(tradeArchive.archivedAt, from),
        lt(tradeArchive.archivedAt, to),
      ),
    )
    .groupBy(tradeArchive.source)
    .orderBy(tradeArchive.source);
}

export async function deleteById(scope: ProfileScope, archiveId: string): Promise<boolean> {
  const rows = await scope.db
    .delete(tradeArchive)
    .where(and(eq(tradeArchive.id, archiveId), eq(tradeArchive.profileId, scope.profileId)))
    .returning({ id: tradeArchive.id });
  return rows.length > 0;
}

/** An archive row needing fee reconciliation: identity + the orders to match. */
export interface UnvaluedFeeRow {
  readonly id: string;
  readonly symbol: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly orders: unknown;
}

/**
 * Archive rows whose fees were never valued (`fees_quote = 0`), newest first.
 * The fee-reconcile job re-derives commission for these from Binance. A genuinely
 * zero-fee row is harmless to revisit (it re-derives to 0); rows that predate the
 * fee column, or whose forward fee lookup degraded, are the real targets.
 */
export async function listWithUnvaluedFees(
  scope: ProfileScope,
  limit: number,
): Promise<UnvaluedFeeRow[]> {
  return scope.db
    .select({
      id: tradeArchive.id,
      symbol: tradeArchive.symbol,
      baseAsset: tradeArchive.baseAsset,
      quoteAsset: tradeArchive.quoteAsset,
      orders: tradeArchive.orders,
    })
    .from(tradeArchive)
    .where(and(eq(tradeArchive.profileId, scope.profileId), eq(tradeArchive.feesQuote, '0')))
    .orderBy(desc(tradeArchive.archivedAt))
    .limit(limit);
}

/** Overwrite an archive row's fee record with reconciled Binance commission. */
export async function updateFees(
  scope: ProfileScope,
  archiveId: string,
  fees: Record<string, string>,
  feesQuote: string,
): Promise<boolean> {
  const rows = await scope.db
    .update(tradeArchive)
    .set({ fees, feesQuote })
    .where(and(eq(tradeArchive.id, archiveId), eq(tradeArchive.profileId, scope.profileId)))
    .returning({ id: tradeArchive.id });
  return rows.length > 0;
}

/**
 * Insert one archive row, deduped on the natural cycle key. Returns the row on
 * success, or `null` when a concurrent consumer already archived this
 * `(profile, symbol, cycle_end)` — the partial unique index makes the second
 * insert a no-op (ON CONFLICT DO NOTHING). A `null` is not an error; the caller
 * logs the collapse. Rows without a `cycleEnd` never dedup (the index is
 * partial), so a caller that omits it keeps the pre-dedup behaviour.
 */
export async function insert(
  scope: ProfileScope,
  input: Omit<TradeArchiveInsert, 'profileId'>,
): Promise<TradeArchiveRow | null> {
  const [row] = await scope.db
    .insert(tradeArchive)
    .values({ ...input, profileId: scope.profileId })
    .onConflictDoNothing({
      target: [tradeArchive.profileId, tradeArchive.symbol, tradeArchive.cycleEnd],
      where: sql`${tradeArchive.cycleEnd} is not null`,
    })
    .returning();
  return row ?? null;
}

export interface ArchiveSummary {
  readonly totalBuyQuote: string;
  readonly totalSellQuote: string;
  /** Quote summed per `"<intent>:<side>"` pair; strategy-specific keys. */
  readonly breakdown: Record<string, string>;
  readonly profit: string;
  readonly profitPercent: string;
  readonly orderCount: number;
  /**
   * SELL rows in the window with no cost basis (`realized_pnl IS NULL`). They
   * contribute nothing to profit — never a fabricated zero-cost gain — so a
   * positive count means the row's realised P/L is a conservative UNDER-count,
   * not wrong. The handler persists it onto the archive row (and logs it), so
   * the API and UI can say "P/L unavailable" rather than render the
   * under-count as a measured `+0.00`.
   */
  readonly missingCostBasis: number;
}

/**
 * Aggregate FILLED `orders` rows for `(profile, symbol)` into the generic
 * `trade_archive` summary. Arithmetic happens in Postgres because
 * `numeric` columns + `numeric` arithmetic are arbitrary-precision so the
 * values round-trip without IEEE-754 loss.
 *
 * Cost-basis accounting, NOT window cashflow. `profit` is the sum of each SELL
 * fill's `realized_pnl` (matched proceeds − cost basis, computed by the
 * fill-adopter at fill time from the position's avg entry price), and
 * `total_buy_quote` is the sum of `cost_basis_quote` (the cost removed from the
 * position). The old `Σ sell − Σ buy` over a time window had no cost basis, so
 * an adopted position (no BUY order row) or a hold spanning an archive boundary
 * inflated profit. A SELL with NULL `realized_pnl` contributes nothing, so an
 * un-costed sale UNDER-counts rather than fabricating a zero-cost gain.
 *
 * `breakdown` groups the raw filled quote by `"<intent>:<side>"` so the operator
 * UI keeps a per-intent split (TT's grid/manual/stop-loss decomposition,
 * momentum's entry/exit, etc.) without dedicated columns.
 *
 * `since` is exclusive (`closed_at > since`); pass `null` to aggregate the
 * all-time history. `until` is inclusive (`closed_at <= until`); pinning the
 * upper bound makes the archive crash-safe: a row closing between the
 * summarise read and the list read can't fall through the gap, and the
 * archive row inserted with `archivedAt = until` keeps the next archive's
 * `since` consistent with the rows already accounted for.
 *
 * Returns `null` when zero matching rows are found. Callers treat `null` as
 * "nothing to archive" and skip the insert.
 */
export async function summarizeArchiveSince(
  scope: ProfileScope,
  symbol: string,
  since: Date | null,
  until: Date,
): Promise<ArchiveSummary | null> {
  // `filled` is the set of FILLED rows in range; `totals` sums by side and
  // `breakdown` aggregates the per-(intent,side) quote into a jsonb object.
  // Every money value is cast to text so the caller never reads a JS
  // `number` for it.
  const result = await scope.db.execute<{
    total_buy_quote: string;
    total_sell_quote: string;
    profit: string;
    profit_percent: string;
    order_count: string;
    missing_cost_basis: string;
    breakdown: Record<string, string>;
  }>(sql`
    with filled as (
      select
        ${orders.intent} as intent,
        ${orders.side} as side,
        (${orders.raw}->>'cummulativeQuoteQty')::numeric as quote,
        ${orders.realizedPnl} as realized_pnl,
        ${orders.costBasisQuote} as cost_basis_quote
      from ${orders}
      where ${orders.profileId} = ${scope.profileId}
        and ${orders.symbol} = ${symbol}
        and ${orders.status} = 'FILLED'
        and ${orders.closedAt} is not null
        and (${since}::timestamptz is null or ${orders.closedAt} > ${since}::timestamptz)
        and ${orders.closedAt} <= ${until}::timestamptz
    ),
    totals as (
      select
        -- Cost basis of the units sold (NULL realized rows excluded by sum).
        coalesce(sum(cost_basis_quote), 0) as total_buy_quote,
        -- Realised P/L = matched proceeds − cost basis, summed across SELL fills.
        coalesce(sum(realized_pnl), 0) as profit,
        count(*) as order_count,
        count(*) filter (where side = 'SELL' and realized_pnl is null) as missing_cost_basis
      from filled
    ),
    grouped as (
      select intent || ':' || side as key, coalesce(sum(quote), 0) as quote
      from filled
      group by intent, side
    ),
    bd as (
      select coalesce(jsonb_object_agg(key, quote::text), '{}'::jsonb) as breakdown
      from grouped
    )
    select
      total_buy_quote::text as total_buy_quote,
      -- Matched proceeds, so profit = total_sell_quote − total_buy_quote holds
      -- exactly and an overshoot's un-costed proceeds are excluded.
      (total_buy_quote + profit)::text as total_sell_quote,
      profit::text as profit,
      case
        when total_buy_quote = 0 then '0'
        else (profit / total_buy_quote * 100)::text
      end as profit_percent,
      order_count::text as order_count,
      missing_cost_basis::text as missing_cost_basis,
      bd.breakdown as breakdown
    from totals, bd
  `);
  // drizzle's `db.execute` shape: pg-style `{ rows }` on node-pg,
  // postgres.js-style array directly. Normalise to a row pointer.
  const r = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  const row = Array.isArray(r) ? (r[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return null;
  const orderCount = Number(row['order_count']);
  if (!Number.isFinite(orderCount) || orderCount === 0) return null;
  return {
    totalBuyQuote: (row['total_buy_quote'] as string) ?? '0',
    totalSellQuote: (row['total_sell_quote'] as string) ?? '0',
    breakdown: (row['breakdown'] as Record<string, string> | null) ?? {},
    profit: (row['profit'] as string) ?? '0',
    profitPercent: (row['profit_percent'] as string) ?? '0',
    orderCount,
    missingCostBasis: Number(row['missing_cost_basis']) || 0,
  };
}

/**
 * Return FILLED `orders` rows for `(profile, symbol)` in the half-open
 * range `(since, until]`. Pairs with {@link summarizeArchiveSince}:
 * the caller summarises the rows into the generic `orders` JSONB column
 * of the new archive row. The `until` upper bound matches the SQL
 * aggregator's cutoff so the two reads agree even if rows close between
 * them.
 */
export async function listClosedSince(
  scope: ProfileScope,
  symbol: string,
  since: Date | null,
  until: Date,
): Promise<OrderRow[]> {
  const conditions = [
    eq(orders.profileId, scope.profileId),
    eq(orders.symbol, symbol),
    eq(orders.status, 'FILLED'),
    isNotNull(orders.closedAt),
    lte(orders.closedAt, until),
  ];
  if (since !== null) conditions.push(gt(orders.closedAt, since));
  return scope.db
    .select()
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.closedAt));
}

/**
 * Latest `archived_at` for `(profile, symbol)`. Drives the `since`
 * cutoff in {@link summarizeArchiveSince} and {@link listClosedSince}
 * so each archive captures only rows closed since the previous archive
 * (or all-time on the first archive).
 */
export async function latestArchivedAt(scope: ProfileScope, symbol: string): Promise<Date | null> {
  const rows = await scope.db
    .select({ archivedAt: tradeArchive.archivedAt })
    .from(tradeArchive)
    .where(and(eq(tradeArchive.profileId, scope.profileId), eq(tradeArchive.symbol, symbol)))
    .orderBy(desc(tradeArchive.archivedAt))
    .limit(1);
  return rows[0]?.archivedAt ?? null;
}

/** Per-(profile, symbol) outcome of one backfill attempt; drives the recover-vs-note split. */
export interface BackfillAttemptOutcome {
  readonly symbol: string;
  /** Round-trips written. > 0 means the coin now has archive rows and leaves the missing set. */
  readonly roundTrips: number;
  /** SELLs with no recorded matching BUY (history predates the bot). */
  readonly skippedOrphanSells: number;
  /** Cycles that sold more base than they bought (surplus from a pre-history position). */
  readonly droppedOvershoot: number;
  /**
   * The attempt stopped because Binance no longer lists the symbol. A
   * terminating outcome: no retry resolves it, so the marker is what stops the
   * recovery sweep re-enqueueing the same doomed job every 15 minutes.
   */
  readonly symbolUnavailable?: boolean;
}

/** A coin with fills and no archive that a backfill attempt could not reconstruct. */
export interface UnreconstructableSymbol {
  readonly symbol: string;
  readonly skippedOrphanSells: number;
  readonly droppedOvershoot: number;
  readonly symbolUnavailable: boolean;
  /** Operator has hidden this coin from the note (still returned so it can be un-hidden). */
  readonly dismissed: boolean;
}

/**
 * Record (upsert) that a backfill ran for `(profile, symbol)`. The marker lets
 * the missing-history nudge tell "not yet checked" from "checked, nothing to
 * recover" so it stops nagging on coins that can never be rebuilt.
 */
export async function recordBackfillAttempt(
  scope: ProfileScope,
  outcome: BackfillAttemptOutcome,
): Promise<void> {
  await scope.db
    .insert(backfillAttempts)
    .values({
      profileId: scope.profileId,
      symbol: outcome.symbol,
      roundTrips: outcome.roundTrips,
      skippedOrphanSells: outcome.skippedOrphanSells,
      droppedOvershoot: outcome.droppedOvershoot,
      symbolUnavailable: outcome.symbolUnavailable ?? false,
    })
    .onConflictDoUpdate({
      target: [backfillAttempts.profileId, backfillAttempts.symbol],
      set: {
        roundTrips: outcome.roundTrips,
        skippedOrphanSells: outcome.skippedOrphanSells,
        droppedOvershoot: outcome.droppedOvershoot,
        symbolUnavailable: outcome.symbolUnavailable ?? false,
        attemptedAt: sql`now()`,
        // A re-attempt is a deliberate "look again", so un-hide the coin: a
        // freshly-checked result should surface in the note, not stay hidden.
        dismissedAt: null,
      },
    });
}

// A backfill marker only speaks for the fills that existed when it was written.
// `applied_fills.applied_at` and `backfill_attempts.attempted_at` are both
// server `now()`, so a fill stamped after the attempt is history the attempt
// never saw, and the marker no longer answers "checked, nothing to recover".
// Without this the live BTCUSDT timeline (BUY 2026-07-07, attempt 2026-07-11,
// SELL 2026-08-01) stays permanently un-recoverable: the round trip that
// completed AFTER the attempt is invisible to both lists.
const staleBackfillMarker = sql`exists (
  select 1 from ${appliedFills} af_new
  where af_new.profile_id = ${backfillAttempts.profileId}
    and af_new.symbol = ${backfillAttempts.symbol}
    and af_new.applied_at > ${backfillAttempts.attemptedAt}
)`;

/**
 * "This coin has a fill the archive does not cover", expressed RELATIVE to what
 * is already archived rather than as "this coin has no archive row at all".
 * The blanket form answers a different question: a grid-traded coin
 * archives cycle 1 fine and then suppresses cycle 2, and a predicate keyed on
 * "ever archived?" can never see that second gap — which is the shape the
 * backstop exists for.
 *
 * The boundary is `archived_at`, not `cycle_end`. `cycle_end` is the closing
 * ORDER's exchange close time, and for a MARKET exit (the dominant one) that
 * row is written already-FILLED at placement, before the execution report is
 * applied — so `applied_at > cycle_end` holds the instant a healthy cycle is
 * archived, and every archived coin would report itself as missing. Forward
 * archiving stamps `archived_at` from its own cutoff, captured after the fill
 * landed, and `archived_at >= cycle_end` on every insert path.
 *
 * `sideFilter` carries everything that differs between the two callers, so the
 * boundary itself is defined once: the actionable list needs a closed cycle (a
 * SELL) that has settled, while the explanatory note also covers a BUY-only
 * coin, which is exactly what its "open or pre-history" reason says.
 */
const unarchivedFill = (
  profileIdRef: ReturnType<typeof sql>,
  symbolRef: ReturnType<typeof sql>,
  sideFilter: ReturnType<typeof sql>,
): ReturnType<typeof sql> => sql`exists (
  select 1 from ${appliedFills} af_sell
  where af_sell.profile_id = ${profileIdRef}
    and af_sell.symbol = ${symbolRef}
    ${sideFilter}
    and af_sell.applied_at > coalesce(
      (
        select max(${tradeArchive.archivedAt})
        from ${tradeArchive}
        where ${tradeArchive.profileId} = ${profileIdRef}
          and ${tradeArchive.symbol} = ${symbolRef}
      ),
      '-infinity'::timestamptz
    )
)`;

// The actionable list additionally waits for the fill to SETTLE. Between the
// closing SELL's `applied_fills` commit and the forward archive's insert the
// cycle legitimately looks unarchived, and a sweep that enqueues a backfill in
// that window races the forward path into a SECOND P/L row for one cycle: the
// two paths derive different `cycle_end` values (the execution report's event
// time vs the `myTrades` row time), so the partial unique index cannot collapse
// them and the profit is counted twice. Well above normal pipeline latency,
// well below the 15-minute sweep period.
const SELL_ONLY = sql`and af_sell.side = 'SELL'
    and af_sell.applied_at < now() - interval '3 minutes'`;
// The note is explanatory, not actionable: it enqueues nothing, so it has no
// race to lose and stays ungraced.
const ANY_SIDE = sql.empty();

/**
 * Coins with a SETTLED closed cycle no archive row covers and no still-valid
 * backfill attempt — the actionable "may have unsaved P/L, recover it" set.
 * Sorted, profile-scoped. A coin whose newest cycle is archived leaves this
 * set; a coin that was attempted and recovered nothing moves to
 * {@link listUnreconstructableSymbols} instead of nagging here forever, until
 * a later fill makes that attempt stale.
 */
export async function listRecoverableSymbols(scope: ProfileScope): Promise<string[]> {
  const rows = await scope.db
    .selectDistinct({ symbol: appliedFills.symbol })
    .from(appliedFills)
    .where(
      and(
        eq(appliedFills.profileId, scope.profileId),
        unarchivedFill(sql`${appliedFills.profileId}`, sql`${appliedFills.symbol}`, SELL_ONLY),
        sql`not exists (
          select 1 from ${backfillAttempts}
          where ${backfillAttempts.profileId} = ${appliedFills.profileId}
            and ${backfillAttempts.symbol} = ${appliedFills.symbol}
            and not ${staleBackfillMarker}
        )`,
      ),
    )
    .orderBy(appliedFills.symbol);
  return rows.map((r) => r.symbol);
}

/**
 * Coins with fills the archive does not cover that a backfill already tried and
 * could not reconstruct (no complete buy→sell cycle, or the symbol is gone from
 * Binance). The reconstruct counts let the UI explain why, as a quiet
 * non-actionable note rather than a warning. Reads from the marker table (one
 * row per symbol) filtered to still-missing coins with fills, so a free-text
 * backfill of a no-fills symbol never appears here.
 *
 * Uses the same {@link unarchivedFill} boundary as
 * {@link listRecoverableSymbols} but without the SELL filter, so an attempted
 * open position still gets its reason. The boundary has to move in step with
 * the actionable list or a coin whose newest cycle is unarchived and
 * unreconstructable falls out of BOTH and is silently dropped — which is the
 * delisted-symbol case.
 *
 * `round_trips = 0` is what keeps an attempt that DID recover history out of a
 * note saying nothing could be recovered: a backfilled row is stamped at the
 * historic closing time, so its fills are always "newer" than it.
 *
 * A marker made stale by a later fill is excluded: that coin is actionable
 * again and belongs to {@link listRecoverableSymbols}. The two lists stay
 * disjoint, so a symbol is never simultaneously "recover this" and "nothing to
 * recover".
 */
export async function listUnreconstructableSymbols(
  scope: ProfileScope,
): Promise<UnreconstructableSymbol[]> {
  return scope.db
    .select({
      symbol: backfillAttempts.symbol,
      skippedOrphanSells: backfillAttempts.skippedOrphanSells,
      droppedOvershoot: backfillAttempts.droppedOvershoot,
      symbolUnavailable: backfillAttempts.symbolUnavailable,
      dismissed: sql<boolean>`${backfillAttempts.dismissedAt} is not null`,
    })
    .from(backfillAttempts)
    .where(
      and(
        eq(backfillAttempts.profileId, scope.profileId),
        eq(backfillAttempts.roundTrips, 0),
        sql`exists (
          select 1 from ${appliedFills}
          where ${appliedFills.profileId} = ${backfillAttempts.profileId}
            and ${appliedFills.symbol} = ${backfillAttempts.symbol}
        )`,
        unarchivedFill(
          sql`${backfillAttempts.profileId}`,
          sql`${backfillAttempts.symbol}`,
          ANY_SIDE,
        ),
        sql`not ${staleBackfillMarker}`,
      ),
    )
    .orderBy(backfillAttempts.symbol);
}

/**
 * Hide (or un-hide) an unreconstructable coin from the note. A no-op when no
 * marker exists for `(profile, symbol)` — only an attempted coin can be hidden.
 * Scoped to the profile.
 */
export async function setUnreconstructableDismissed(
  scope: ProfileScope,
  symbol: string,
  dismissed: boolean,
): Promise<void> {
  await scope.db
    .update(backfillAttempts)
    .set({ dismissedAt: dismissed ? sql`now()` : null })
    .where(
      and(eq(backfillAttempts.profileId, scope.profileId), eq(backfillAttempts.symbol, symbol)),
    );
}
