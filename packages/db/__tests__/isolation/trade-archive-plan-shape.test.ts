import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profileRepo, type ProfileRepo } from '../../src/repo/index.js';
import { appliedFills } from '../../src/schema/applied-fills.js';
import * as schema from '../../src/schema/index.js';
import { setupFixture, TEST_DB_URL, type IsolationFixture } from './_helpers.js';

/**
 * Plan-shape lock for the two archive-coverage readers. Both build their coverage test from one shared helper whose inner `not exists` references the profile id and symbol of the OUTER-OUTER query, so the correlation spans two nesting levels. Postgres can only pull a subquery into an anti-join with its immediate parent, so a two-level correlation degrades into a per-row `SubPlan` that re-expands every archived `orders` array once per candidate fill. That is a runtime cliff, not a slowdown: on a real archive the query does not finish.
 *
 * The assertion is on subquery FLATTENING, never on the join algorithm. Whether the flattened form comes out as a hash, merge, or nested-loop anti-join is cost-driven and flips with table size, so pinning it would make this test track fixture scale instead of the defect. Flattening is a rewrite-stage decision and is size-independent, which is what makes it a stable gate.
 *
 * Skipped when `DATABASE_TEST_URL` is not set so `bun run test` works on workstations without a Postgres available.
 */
const describeIfDb = TEST_DB_URL ? describe : describe.skip;

interface CapturedQuery {
  text: string;
  params: unknown[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Collects every plan node in an `EXPLAIN (FORMAT JSON)` document. Walks the whole tree rather than only `Plans`, because `EXPLAIN` hangs subquery nodes off several different keys depending on how the planner classified them. */
const collectPlanNodes = (value: unknown, out: Record<string, unknown>[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectPlanNodes(item, out);
    return;
  }
  if (!isRecord(value)) return;
  if ('Node Type' in value) out.push(value);
  for (const child of Object.values(value)) collectPlanNodes(child, out);
};

/** An archive row naming one order id the seeded fills never use, so the coverage subquery has rows to expand and cannot short-circuit on an empty archive. The money fields are inert: nothing here reads them, only the id matters. */
const uncoveringArchive = (symbol: string, baseAsset: string, uncoveredOrderId: string) => ({
  symbol,
  baseAsset,
  quoteAsset: 'USDT',
  totalBuyQuote: '60000',
  totalSellQuote: '62000',
  breakdown: { 'grid-buy:BUY': '60000', 'grid-sell:SELL': '62000' },
  profit: '2000',
  orders: [{ binanceOrderId: uncoveredOrderId, side: 'BUY' as const }],
  archivedAt: new Date('2026-05-11T00:00:00Z'),
});

describeIfDb('trade-archive coverage readers plan without a correlated subplan', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let logged: CapturedQuery[] = [];

  /** Ages a symbol's fills past the settling grace and behind any backfill marker written afterwards. `listRecoverableSymbols` ignores an unsettled SELL, and a fill newer than a marker makes that marker stale, so both readers need the fills backdated to reach the coverage helper at all. */
  const backdateFills = async (symbol: string): Promise<void> => {
    await fx.db
      .update(appliedFills)
      .set({ appliedAt: new Date(Date.now() - 3_600_000) })
      .where(and(eq(appliedFills.profileId, fx.alice.profileId), eq(appliedFills.symbol, symbol)));
  };

  /** Explains one statement under `EXPLAIN (FORMAT JSON)`, reusing its bind values so the planner sees the real parameters rather than a generic plan. */
  const explainNodes = async (query: CapturedQuery): Promise<Record<string, unknown>[]> => {
    const explained = await fx.pool.query<{ 'QUERY PLAN': unknown }>({
      text: `explain (format json) ${query.text}`,
      values: query.params,
    });
    const nodes: Record<string, unknown>[] = [];
    collectPlanNodes(explained.rows[0]?.['QUERY PLAN'], nodes);
    return nodes;
  };

  /** Runs a reader on the logging handle and explains EVERY statement it issued that expands the archived `orders` array. `jsonb_array_elements` appears only in the coverage helper, so it picks those out from the scope-proving reads the repo also issues. Explaining all of them rather than the first keeps the gate from silently narrowing if a reader is ever split into two coverage passes. */
  const planNodesFor = async (run: () => Promise<unknown>): Promise<Record<string, unknown>[]> => {
    logged = [];
    await run();
    const targets = logged.filter((q) => q.text.includes('jsonb_array_elements'));
    if (targets.length === 0) throw new Error('no coverage query was captured');
    const nodes: Record<string, unknown>[] = [];
    for (const target of targets) nodes.push(...(await explainNodes(target)));
    if (nodes.length === 0) throw new Error('EXPLAIN returned no plan nodes');
    return nodes;
  };

  /** True when this node's subtree scans the archive. `trade_archive` is read in exactly one place in either reader, the coverage subquery, so it is a precise fingerprint for that subquery wherever the planner ended up putting it. */
  const subtreeScansArchive = (node: Record<string, unknown>): boolean => {
    const subtree: Record<string, unknown>[] = [];
    collectPlanNodes(node, subtree);
    return subtree.some((n) => n['Relation Name'] === 'trade_archive');
  };

  /** Names the offending nodes so a failure reads as "which subplan", not "expected 1 to be 0". `InitPlan` is matched alongside `SubPlan` rather than excluded as harmless: Postgres labels a subquery that skips its immediate parent and correlates only with a level above it an InitPlan too, and that form is re-evaluated every time the outer parameter changes, which is the same per-row cliff under a different name. Requiring the archive in the subtree is what keeps a genuinely once-per-statement InitPlan out, so the gate stays precise without relying on the relationship label to mean "harmless". */
  const perRowArchiveExpansions = (nodes: Record<string, unknown>[]): unknown[] =>
    nodes
      .filter(
        (n) => n['Parent Relationship'] === 'SubPlan' || n['Parent Relationship'] === 'InitPlan',
      )
      .filter(subtreeScansArchive)
      .map((n) => n['Subplan Name'] ?? n['Node Type']);

  beforeAll(async () => {
    fx = await setupFixture();
    const loggingDb = drizzle(fx.pool, {
      schema,
      logger: {
        logQuery: (text: string, params: unknown[]) => {
          logged.push({ text, params });
        },
      },
    });
    ap = await profileRepo(loggingDb, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);

    // Actionable-list seed: a settled closed cycle plus an archive row that names a DIFFERENT order id, so the inner `not exists` has rows to expand and cannot short-circuit on an empty archive.
    await ap.appliedFills.tryRecord({
      symbol: 'PLANRECUSDT',
      orderId: 101,
      tradeId: 101,
      side: 'BUY',
    });
    await ap.appliedFills.tryRecord({
      symbol: 'PLANRECUSDT',
      orderId: 102,
      tradeId: 102,
      side: 'SELL',
    });
    await ap.tradeArchive.insert(uncoveringArchive('PLANRECUSDT', 'PLANREC', '999'));
    await backdateFills('PLANRECUSDT');

    // Explanatory-note seed: a fill, an uncovering archive row, and a marker that recovered nothing and post-dates the fill, so the note's outer filters all pass and the coverage helper is reached.
    await ap.appliedFills.tryRecord({
      symbol: 'PLANUNRUSDT',
      orderId: 201,
      tradeId: 201,
      side: 'BUY',
    });
    await ap.tradeArchive.insert(uncoveringArchive('PLANUNRUSDT', 'PLANUNR', '888'));
    await backdateFills('PLANUNRUSDT');
    await ap.tradeArchive.recordBackfillAttempt({
      symbol: 'PLANUNRUSDT',
      roundTrips: 0,
      skippedOrphanSells: 0,
      droppedOvershoot: 0,
    });
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('listRecoverableSymbols flattens its coverage test into a join', async () => {
    const nodes = await planNodesFor(async () => {
      // A seeded hit proves the planned query is the one that answers the question, not a shape that happens to return nothing.
      expect(await ap.tradeArchive.listRecoverableSymbols()).toContain('PLANRECUSDT');
    });
    expect(perRowArchiveExpansions(nodes)).toEqual([]);
  });

  it('listUnreconstructableSymbols flattens its coverage test into a join', async () => {
    const nodes = await planNodesFor(async () => {
      const rows = await ap.tradeArchive.listUnreconstructableSymbols();
      expect(rows.map((r) => r.symbol)).toContain('PLANUNRUSDT');
    });
    expect(perRowArchiveExpansions(nodes)).toEqual([]);
  });

  it('reports a two-level correlation, so the two gates above cannot pass vacuously', async () => {
    // The gates above assert an ABSENCE, which is also what a detector that can never match returns. `Parent Relationship` is emitted by the server rather than promised by the documented EXPLAIN output, so a key rename on a future Postgres, or a walk that stops reaching subplan branches, would retire both of them silently. This explains the pre-fix shape, where `ta` reaches `af` two levels up, and fails if that no longer registers as a subplan.
    const nodes = await explainNodes({
      text: `select distinct af.symbol from applied_fills af
             where af.profile_id = $1
               and exists (
                 select 1 from applied_fills af_sell
                 where af_sell.profile_id = af.profile_id
                   and af_sell.symbol = af.symbol
                   and af_sell.side = 'SELL'
                   and not exists (
                     select 1 from trade_archive ta
                     cross join lateral jsonb_array_elements(ta.orders) archived_order
                     where ta.profile_id = af.profile_id
                       and ta.symbol = af.symbol
                       and archived_order->>'binanceOrderId' = af_sell.order_id::text
                   )
               )`,
      params: [fx.alice.profileId],
    });
    expect(perRowArchiveExpansions(nodes).length).toBeGreaterThan(0);
  });
});

/**
 * Rows seeded for one profile before the pagination plan is measured.
 *
 * Chosen so a whole-archive sort is the planner's natural choice without the seed itself dominating the suite: at this size the sort is unambiguous in the plan and the insert is one statement. The number is not a threshold — the defect is that page cost scales with the archive rather than with `limit`, so any corpus large enough to make the sort visible reports the same shape. A real operator's archive is orders of magnitude larger, which is where the same plan stops being slow and starts being a 503.
 */
const PAGINATION_CORPUS_ROWS = 5_000;

/** How deep into the corpus the measured cursor sits. A page near the head can be answered by a partial sort or an early exit, so a shallow cursor would let the sort look cheap and the gate would pass on a case the operator never hits. */
const DEEP_CURSOR_OFFSET = 4_000;

/** The index that has to serve `(profile_id, archived_at DESC, id DESC)`, named so the assertion fails on "some index" as loudly as on "no index". */
const ARCHIVE_PAGE_INDEX = 'trade_archive_profile_archived_id';

describeIfDb('trade-archive pagination reads an index, not the whole archive', () => {
  let fx: IsolationFixture;
  let ap: ProfileRepo;
  let logged: CapturedQuery[] = [];
  let deepCursor: { archivedAt: string; id: string };

  beforeAll(async () => {
    fx = await setupFixture();
    const loggingDb = drizzle(fx.pool, {
      schema,
      logger: {
        logQuery: (text: string, params: unknown[]) => {
          logged.push({ text, params });
        },
      },
    });
    ap = await profileRepo(loggingDb, fx.alice.userId, fx.alice.accountId, fx.alice.profileId);

    // Inserted as one statement rather than through the repo: the seed is inert scaffolding for the planner, and 5,000 round-trips through `insert` would make the setup the slowest thing in the suite. One second per row keeps every `archived_at` distinct, so the keyset's tie-breaker is exercised on a real ordering rather than on a block of identical timestamps.
    await fx.pool.query(
      `insert into trade_archive (profile_id, symbol, base_asset, quote_asset,
                                  total_buy_quote, total_sell_quote, profit, archived_at)
       select $1, 'PAGEUSDT', 'PAGE', 'USDT', 100, 101, 1,
              timestamptz '2026-01-01T00:00:00Z' - (g || ' seconds')::interval
       from generate_series(1, $2) g`,
      [fx.alice.profileId, PAGINATION_CORPUS_ROWS],
    );
    // Without fresh statistics the planner costs the corpus off the empty-table defaults and picks a shape no production database would, so the measurement would be of the fixture rather than of the query.
    await fx.pool.query('analyze trade_archive');

    // The cursor the route would have emitted at this depth, taken at the microsecond precision the token carries rather than re-derived from a JS Date.
    const boundary = await fx.pool.query<{ token: string; id: string }>(
      `select to_char(archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as token,
              id::text as id
       from trade_archive
       where profile_id = $1
       order by archived_at desc, id desc
       offset $2 limit 1`,
      [fx.alice.profileId, DEEP_CURSOR_OFFSET],
    );
    const row = boundary.rows[0];
    if (!row) throw new Error('the pagination corpus did not reach the cursor depth');
    deepCursor = { archivedAt: row.token, id: row.id };
  });

  afterAll(async () => {
    if (fx) await fx.cleanup();
  });

  it('answers a deep page from the keyset index without sorting the archive', async () => {
    // Three properties of one plan, so they are measured on one run of the real statement: the page must not sort (cost scales with the archive, not with `limit`), the index has to carry BOTH keyset columns (an index cond on `archived_at` alone leaves the tie-breaker to a filter), and nothing may be read and discarded (rows removed by filter are rows the index should have skipped).
    logged = [];
    const page = await ap.tradeArchive.listForProfilePaginated(25, null, deepCursor);
    expect(page).toHaveLength(25);

    const target = logged.find((q) => q.text.includes('trade_archive'));
    if (!target) throw new Error('no trade_archive query was captured');
    const explained = await fx.pool.query<{ 'QUERY PLAN': unknown }>({
      text: `explain (analyze, buffers, format json) ${target.text}`,
      values: target.params,
    });
    const nodes: Record<string, unknown>[] = [];
    collectPlanNodes(explained.rows[0]?.['QUERY PLAN'], nodes);
    expect(nodes.length).toBeGreaterThan(0);

    expect(nodes.filter((n) => String(n['Node Type']).includes('Sort'))).toEqual([]);

    const scan = nodes.find((n) => n['Index Name'] === ARCHIVE_PAGE_INDEX);
    expect(scan).toBeDefined();
    // `profile_id` is masked out before the cursor columns are looked for. It is always in this condition and it CONTAINS the substring `id`, so an unmasked `toContain('id')` would hold for every possible plan — including one where the row comparison fell back to a per-row filter, which is the shape this assertion exists to catch.
    const boundary = String(scan?.['Index Cond'] ?? '').replaceAll('profile_id', '');
    expect(boundary).toContain('archived_at');
    expect(boundary).toMatch(/\bid\b/);

    // Exactly zero, not "few": the keyset predicate is the index's own start position, so a row reaching a filter at all means the boundary was re-checked per row instead of seeked to.
    const removedByFilter = nodes.reduce(
      (sum, n) => sum + Number(n['Rows Removed by Filter'] ?? 0),
      0,
    );
    expect(removedByFilter).toBe(0);
  });
});
