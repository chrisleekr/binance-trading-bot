import {
  ArchivePeriod,
  ArchiveSort,
  ArchiveSortDir,
  asDecimalString,
  asProfileId,
  coerceArchivedOrderDetails,
  coerceArchivedOrders,
  decimalSub,
  deriveEntryAt,
  deriveExitAt,
  deriveExitIntent,
  ErrorEnvelope,
  holdMsBetween,
  ProfileArchiveListResponse,
  rollupByExitIntent,
  rollupBySource,
  TradeArchiveBackfillRequest,
  TradeArchiveBackfillResponse,
  TradeArchiveDetailResponse,
  UnreconstructableDismissRequest,
  UnreconstructableDismissResponse,
  type UnreconstructableReason,
} from '@app/contracts';
import { profileRepo, withStatementTimeout, type TradeArchiveRow } from '@app/db';
import { Decimal } from '@app/money';
import { createHash } from 'node:crypto';
import { HttpError } from 'middleware/error.js';
import { createRoute, z } from '@hono/zod-openapi';
import { stream } from 'hono/streaming';
import type { DI } from 'di.js';
import { compositeCursor, splitCompositeCursor } from 'lib/cursor.js';
import { periodWindow } from 'lib/period-window.js';
import { requireNotDemo } from 'middleware/require-not-demo.js';
import { requireUser } from 'middleware/require-user.js';
import { accountIdOf, scopeOf, userIdOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

/**
 * Per-statement execution budget for the archive page's reads.
 *
 * Far below the 30s the background recovery sweep allows itself: an operator is watching this one, and a read still running after five seconds has already lost the page. The cap is per statement and the transaction issues up to five that can stall on a `view=full` request — the ownership join `profileRepo` mints, then the four reads, all serial — so the worst case one request can hold its pooled connection is five times this, 25 seconds. A `view=rollup` request issues two, and that is what every polling surface asks for. That is the number that has to stay small, because the connection is one of ten the whole api shares.
 *
 * 25s does exceed the 5s pool checkout deadline, so under sustained archive concurrency a waiter can be rejected while the holder is still legitimately working. That is accepted rather than papered over by shrinking the budget: the budget bounds a pathological stall, not the healthy case, where each read returns in roughly a tenth of a second. Sizing it down to make the arithmetic tidier would cap real work on evidence we do not have — there is no production timing for `listForProfileInRange` against a large archive.
 *
 * The budget no longer doubles as a size limit on the archive. `listForProfilePaginated` once sorted the profile's whole archive on every page, because no index carried its `(archived_at DESC, id DESC)` order and the keyset boundary was an OR pair the planner could only apply as a per-row filter; page cost therefore scaled with the archive's total size rather than with `limit`, and past the size where that sort took five seconds the page became a 503 on every load. `trade_archive_profile_archived_id` plus a row-comparison boundary made it an index-ordered read of `limit` rows, so the budget now bounds a pathological stall and nothing else. `listForProfileInRange` is still unpaginated by design — it is the rollup's whole-period source — so it remains the read this cap actually exists for.
 */
const ARCHIVE_READ_BUDGET_MS = 5_000;

/**
 * Map a backfill attempt's outcome to the operator-facing reason. A delisted
 * symbol wins outright: the attempt never got as far as reading trades, so its
 * zero counts say nothing, and it is the only reason a retry cannot change.
 * Then overshoot (sold more than bought), the most specific data problem, then
 * orphan sells; a zero-zero attempt is a bought-not-fully-sold or pre-history
 * open position.
 */
function unreconstructableReason(u: {
  skippedOrphanSells: number;
  droppedOvershoot: number;
  symbolUnavailable: boolean;
}): UnreconstructableReason {
  if (u.symbolUnavailable) return 'symbol-unavailable';
  if (u.droppedOvershoot > 0) return 'overshoot';
  if (u.skippedOrphanSells > 0) return 'orphan-sells';
  return 'open-or-pre-history';
}

const ProfileIdParam = z.object({ profileId: z.uuid() });

/** The cycle's exit intent, off the same coerced orders every other derived field reads, so a row's badge and its bucket can never come from two different readings of the column. */
const exitIntentOf = (orders: unknown): string => deriveExitIntent(coerceArchivedOrders(orders));

/** Delimiter of the token this route emits. Two characters, so it cannot occur inside either half. */
const CURSOR_SEPARATOR = '__';

/**
 * The composite cursor this route emits, and the only shape it accepts: `<archivedAt-iso>__<row id>`.
 *
 * Validating it as a plain ISO timestamp once rejected the route's own `nextCursor` as a 422, so paging past the first page was impossible and the archive silently stopped at 25 rows. The correction is to accept the composite form, NOT to also keep accepting a bare timestamp: a bare cursor carries no row id, and one minted before this route emitted microseconds carries only milliseconds. Either way it cannot address a row inside a shared timestamp, so it would strand the rows below the boundary exactly as the millisecond cursor did — silently, which is the failure mode worth refusing outright. A cursor the route did not emit is a 422 the client recovers from by restarting the walk.
 */
const ArchiveCursor = compositeCursor({ separator: CURSOR_SEPARATOR, allowBareTimestamp: false });

/**
 * The cursor the derived-sort path emits and accepts: `<sequence tag>:<offset>`.
 *
 * An offset names a POSITION, which means nothing once the sequence it counts into changes — unlike the keyset token next door, which names a boundary ROW and therefore degrades safely. Carrying the sort key alone was not enough: the offset is applied AFTER the row filters and the window, so replaying page 2 of a 200-row set against a set the symbol filter has cut to 30 answers rows 25-29 as "page 2" without a word. The tag folds every input that decides which rows are in the sequence and in what order, so any change to it is a mismatch the handler refuses. The offset is bounded to six digits: this path materialises the period set, so an offset past it addresses nothing.
 */
const OFFSET_CURSOR = /^([0-9a-f]{12}):(\d{1,6})$/;

/**
 * The sequence tag an offset cursor is only valid against.
 *
 * Truncated to 12 hex characters, which is an identity check and not a security boundary: the token is round-tripped through the operator's own session, and a forged tag buys the forger a page of their own archive. NUL-joined so no field's value can spell another's boundary, and every optional field contributes a fixed slot so an absent filter and an empty one cannot fold to the same tag.
 *
 * @param q - The validated query, read for its ordering, its three row filters and the window (`period`, `tz` and the custom bounds) that resolves which rows exist at all.
 * @returns The tag this request's cursors carry.
 */
const sequenceTag = (q: {
  sort: ArchiveSort;
  dir: ArchiveSortDir;
  period: string;
  tz: string;
  symbol?: string | undefined;
  exitIntent?: string | undefined;
  source?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}): string =>
  createHash('sha256')
    .update(
      [
        q.sort,
        q.dir,
        q.period,
        q.tz,
        // Verbatim, not normalised: any change to the query is a change to the request, and a client that re-spells a filter mid-walk gets a 422 it recovers from by restarting. Erasing a difference here to be lenient is how a tag stops naming the sequence it is supposed to identify.
        q.symbol ?? '',
        q.exitIntent ?? '',
        q.source ?? '',
        q.from ?? '',
        q.to ?? '',
      ].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 12);

const ArchiveQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  // Either cursor shape: the keyset token for the default `archivedAt desc` walk, the offset token for every ordering no index can serve. The handler decides which one this request is allowed to carry — accepting both here only keeps a wrong-shaped cursor from failing as a generic query error before it can be told apart from a wrong-key one.
  cursor: z.union([ArchiveCursor, z.string().regex(OFFSET_CURSOR)]).optional(),
  // A custom range, overriding `period`. Sent by the History page's date pickers; when either bound is present the response's `from`/`to` echo what actually scoped the read, so the rollups and the equity chart cannot disagree about the window.
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  // `archivedAt` is the only key an index carries; the rest are derived per row (net P/L is profit minus fees, hold is the gap between the cycle's first buy and its last sell), so ordering by them means ordering the period set in memory.
  sort: ArchiveSort.default('archivedAt'),
  dir: ArchiveSortDir.default('desc'),
  // Row filters. They narrow the LIST only: the rollups are what the operator drills from, so filtering them by the value just clicked would collapse them to the single bucket already selected.
  symbol: z.string().min(1).max(32).optional(),
  exitIntent: z.string().min(1).max(64).optional(),
  source: z.enum(['auto', 'manual', 'unknown']).optional(),
  // Which reads the page needs. The dashboard's edge verdict and its live-vs-backtest card both want one field, `bySource`, over all time, and both poll it every 60s — under `full` that loaded a page of rows plus two whole-archive coverage scans to build a response they discard. `rollup` asks for the rollup's source read and nothing else; the fields the other reads would have filled are then OMITTED rather than sent empty, because an empty list is a claim about the archive that this response did not check.
  view: z.enum(['full', 'rollup']).default('full'),
  period: ArchivePeriod.default('a'),
  // tz is operator-controlled; default to UTC because the worker doesn't
  // know the operator's timezone — the SPA passes its own. Validate as a
  // real IANA zone so an invalid value 4xx's at the boundary instead of
  // throwing later when periodWindow builds an Intl.DateTimeFormat.
  tz: z
    .string()
    .min(1)
    .max(64)
    .refine(
      (value) => {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      },
      { message: 'tz must be a valid IANA timezone' },
    )
    .default('UTC'),
});

/**
 * The wire shape of one archived cycle, off a whole `trade_archive` row.
 *
 * One projection for every surface that emits a row — the paged list, the derived-sort page and the NDJSON export — because the export exists to be reconciled against what the screen showed, and two projections drifting apart is how it stops being.
 *
 * @param r - The archive row as stored.
 * @returns The row as the API states it, with the three fields the column does not hold: the exit intent, and the cycle's entry and exit instants.
 */
const archiveItem = (r: TradeArchiveRow) => ({
  id: r.id,
  symbol: r.symbol,
  baseAsset: r.baseAsset,
  quoteAsset: r.quoteAsset,
  totalBuyQuote: asDecimalString(r.totalBuyQuote),
  totalSellQuote: asDecimalString(r.totalSellQuote),
  breakdown: Object.fromEntries(
    Object.entries((r.breakdown ?? {}) as Record<string, string>).map(([k, v]) => [
      k,
      asDecimalString(v),
    ]),
  ),
  fees: Object.fromEntries(
    Object.entries((r.fees ?? {}) as Record<string, string>).map(([k, v]) => [
      k,
      asDecimalString(v),
    ]),
  ),
  feesQuote: asDecimalString(r.feesQuote),
  feeBasis: r.feeBasis,
  netProfit: decimalSub(asDecimalString(r.profit), asDecimalString(r.feesQuote)),
  profit: asDecimalString(r.profit),
  exitIntent: exitIntentOf(r.orders),
  // Earliest BUY close in the cycle, null on a backfilled row whose reconstructed orders carry no stamp — the honest answer, which the row renders as an em dash rather than a zero-length hold.
  entryAt: deriveEntryAt(coerceArchivedOrders(r.orders)),
  // The latest SELL close, and only that. The stored `cycle_end` was preferred here, but the forward writer falls back to the archive cutoff when the cycle has no closed sell to read, which is not an exit instant at all — and the rollup's average hold reads `deriveExitAt` unconditionally, so the Held column and the Avg-hold figure beside it came off two different instants. One derivation also keeps the reported exit TIME and the exit REASON, which `deriveExitIntent` reads off the same orders, describing the same order.
  exitAt: deriveExitAt(coerceArchivedOrders(r.orders)),
  // Carried so the UI can say "P/L unavailable" instead of rendering an
  // under-counted `profit` of 0 as a measured break-even.
  missingCostBasis: r.missingCostBasis,
  archivedAt: r.archivedAt.toISOString(),
});

type ArchiveItem = ReturnType<typeof archiveItem>;

/** How long the cycle was held, off the shared span rule so this route's sort and the rollup's average hold apply one definition of an unusable span. A row that cannot prove its hold is not a zero-length hold, so it sorts to the end of either direction rather than winning "shortest". */
const holdMsOf = (item: ArchiveItem): number | null => holdMsBetween(item.entryAt, item.exitAt);

/**
 * The amount the requested key ranks on, or null where the ledger has no figure to rank.
 *
 * The withholding rule is the ledger's own, not a second one invented here: a cycle with an un-costed sell renders `n/a` on both bases, and a cycle whose commission is missing outright renders `n/a` on Net. Ranking those rows by the stored number orders the page on a figure the operator is looking at a dash in place of, which reads as an arbitrary shuffle of the unreadable rows through the middle of the ordering. The hold key beside this already sinks its own unprovable rows for the same reason.
 *
 * @param item - The wire item, read for the two P/L amounts and the two fields that say whether either is trustworthy.
 * @param sort - Which of the two amounts is being ranked.
 * @returns The amount as a `Decimal`, or null when the ledger withholds it.
 */
const pnlKeyOf = (item: ArchiveItem, sort: 'profit' | 'netProfit'): Decimal | null => {
  if (item.missingCostBasis > 0) return null;
  if (sort === 'netProfit' && item.feeBasis === 'unknown') return null;
  return new Decimal(sort === 'profit' ? item.profit : item.netProfit);
};

/**
 * One item beside the sort keys that cost more than a comparison to derive.
 *
 * Derived once per row rather than inside the comparator, which the engine calls O(n log n) times: this route sorts the WHOLE period in memory, capped at `EXPORT_MAX_ROWS`, so a per-comparison `Date.parse` and `new Decimal` is millions of parses on the api process's only thread. `symbol` and `archivedAt` are compared verbatim and need no key.
 */
interface KeyedItem {
  readonly item: ArchiveItem;
  readonly holdMs: number | null;
  readonly pnl: Decimal | null;
}

/** Orders two values of one relationally-comparable type. Spelled out rather than subtracted, because the same rule has to serve the ISO timestamps, the row ids and the millisecond holds this page sorts on. */
const compareBy = <T extends string | number>(a: T, b: T): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/** Orders two keys of which either may be missing, sinking the missing ones to the end of BOTH directions. `flip` is applied by the caller to the present-pair result alone, so a row with no readable key never rises to the top by reversing the sort. */
const compareNullableKey = <T>(
  a: T | null,
  b: T | null,
  cmp: (x: T, y: T) => number,
  flip: number,
  tie: number,
): number => {
  if (a === null && b === null) return tie;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmp(a, b) * flip || tie;
};

/**
 * Comparator for the derived-sort page.
 *
 * Ends on the row id whatever the key, because offset paging over a partial order is not stable: two rows tied on net P/L can swap between the request for page 1 and the request for page 2, which shows one of them twice and the other never — and nothing in the response says so.
 *
 * @param sort - The requested key.
 * @param dir - The requested direction; it flips the key comparison only, never the missing-key rule or the id tie-break.
 * @returns A total order over keyed archive items.
 */
const compareItems =
  (sort: ArchiveSort, dir: ArchiveSortDir) =>
  (a: KeyedItem, b: KeyedItem): number => {
    const flip = dir === 'desc' ? -1 : 1;
    const tie = compareBy(a.item.id, b.item.id);
    if (sort === 'holdMs') return compareNullableKey(a.holdMs, b.holdMs, compareBy, flip, tie);
    if (sort === 'profit' || sort === 'netProfit') {
      return compareNullableKey(a.pnl, b.pnl, (x, y) => x.comparedTo(y), flip, tie);
    }
    const keyed =
      sort === 'symbol'
        ? a.item.symbol.localeCompare(b.item.symbol)
        : compareBy(a.item.archivedAt, b.item.archivedAt);
    return keyed * flip || tie;
  };

/**
 * The period set as one ordering: filtered to the requested rows, ordered by the requested key.
 *
 * Shared by the list and its export so a downloaded file always matches what was on screen. The audit export next door states that it exports the complete log rather than the current filter; that is a wart to work around, not a pattern to copy — an export whose contents silently disagree with the view it was taken from is evidence of nothing.
 *
 * @param rows - Every archive row in the resolved window.
 * @param q - The validated query, read for its three row filters and its ordering.
 * @returns The matching rows as wire items, in a total order.
 */
const selectArchiveItems = (
  rows: TradeArchiveRow[],
  q: {
    symbol?: string | undefined;
    exitIntent?: string | undefined;
    source?: string | undefined;
    sort: ArchiveSort;
    dir: ArchiveSortDir;
  },
): ArchiveItem[] => {
  // Upper-cased because `trade_archive.symbol` holds Binance's casing and the query string is operator-typed; a lower-case `btcusdt` filtering to zero rows reads as "this coin never traded".
  const symbol = q.symbol?.toUpperCase();
  const pnlSort = q.sort === 'profit' || q.sort === 'netProfit' ? q.sort : null;
  return rows
    .filter((r) => q.source === undefined || r.source === q.source)
    .map(archiveItem)
    .filter(
      (item) =>
        (symbol === undefined || item.symbol === symbol) &&
        (q.exitIntent === undefined || item.exitIntent === q.exitIntent),
    )
    .map((item) => ({
      item,
      holdMs: q.sort === 'holdMs' ? holdMsOf(item) : null,
      pnl: pnlSort === null ? null : pnlKeyOf(item, pnlSort),
    }))
    .sort(compareItems(q.sort, q.dir))
    .map((keyed) => keyed.item);
};

/** Absolute cap on rows one archive export may emit, and the page it walks in. The archive is small per profile — the largest live one holds ~52 rows against the action log's millions — so the cap exists to bound a pathological profile, and is stated in a trailing line rather than applied silently. */
const EXPORT_MAX_ROWS = 100_000;

const route = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/trade-archive',
  tags: ['archive'],
  request: { params: ProfileIdParam, query: ArchiveQuery },
  responses: {
    200: {
      description: 'paginated archive entries',
      content: { 'application/json': { schema: ProfileArchiveListResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    // Both are reachable and neither was declared. A malformed `cursor` fails `ArchiveCursor` at the boundary, and the reads run under a statement budget whose expiry answers SERVICE_UNAVAILABLE — a client generated from this document would otherwise treat either as an undeclared protocol error.
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
    503: { description: 'UNAVAILABLE', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const SymbolParam = z.object({ profileId: z.uuid(), symbol: z.string().min(1) });

/** The window and ordering an export is taken under. The same fields as the list query minus its paging: an export is the whole selection, so `limit` and `cursor` would be a contradiction. */
const ExportQuery = ArchiveQuery.omit({ limit: true, cursor: true, view: true });

const exportRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/trade-archive/export',
  tags: ['archive'],
  request: { params: ProfileIdParam, query: ExportQuery },
  responses: {
    // Declared without a content schema, as the action-log export is: the handler answers with a stream, and a declared `content` makes zod-openapi demand a typed JSON response the route by definition never produces.
    200: { description: 'NDJSON stream of the selected archive rows, one JSON object per line' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const detailRoute = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/trade-archive/{archiveId}',
  tags: ['archive'],
  request: { params: z.object({ profileId: z.uuid(), archiveId: z.uuid() }) },
  responses: {
    200: {
      description: 'the fills behind one archived cycle',
      content: { 'application/json': { schema: TradeArchiveDetailResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const backfillRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/trade-archive-backfill',
  tags: ['archive'],
  request: {
    params: SymbolParam,
    body: { content: { 'application/json': { schema: TradeArchiveBackfillRequest } } },
  },
  responses: {
    202: {
      description: 'backfill scheduled',
      content: { 'application/json': { schema: TradeArchiveBackfillResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const dismissRoute = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/symbols/{symbol}/unreconstructable-dismiss',
  tags: ['archive'],
  request: {
    params: SymbolParam,
    body: { content: { 'application/json': { schema: UnreconstructableDismissRequest } } },
  },
  responses: {
    200: {
      description: 'visibility updated',
      content: { 'application/json': { schema: UnreconstructableDismissResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

/**
 * `GET /profiles/:id/trade-archive` — paginated profile-level archive.
 *
 * Cursor pagination because new archive rows can land while the operator
 * pages through; an offset would re-show or skip entries. The period
 * window uses the same locale-aware helper as the closed-trades widget so
 * day/week/month boundaries match between the two views.
 *
 * `POST /profiles/:id/symbols/:symbol/trade-archive-backfill` enqueues a
 * worker job that reconstructs historic round-trips from Binance `myTrades`.
 * The reconstruction needs Binance trade history (and pins fees) the request
 * context lacks, so it runs on the worker; the route only acknowledges.
 */
export const archiveRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/trade-archive', requireUser());
  // The list path and everything under it. A `use` on the parent path alone does NOT cover its children in hono, so without this second line the export and the detail sheet — the two surfaces that ship the most per-trade data — would be the only unauthenticated routes in the router.
  app.use('/profiles/*/trade-archive/*', requireUser());
  app.use('/profiles/*/symbols/*/trade-archive-backfill', requireUser());
  app.use('/profiles/*/symbols/*/unreconstructable-dismiss', requireUser());
  // Same hazard as reconcile-fees: one weighted Binance `myTrades` pull per click, and the jobId carries a timestamp so repeats never dedup. Worse here, because "Recover all" fires one of these per recoverable symbol in a single uncapped fan-out.
  app.on('POST', '/profiles/:profileId/symbols/:symbol/trade-archive-backfill', requireNotDemo(di));

  app.openapi(route, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const q = c.req.valid('query');
    const { limit, cursor, period, tz, view, sort, dir } = q;

    const { from, to } = periodWindow(period, tz, new Date());
    const customFrom = q.from === undefined ? null : new Date(q.from);
    const customTo = q.to === undefined ? null : new Date(q.to);
    // An inverted range is empty, and an empty archive page reads exactly like a profile that has never traded. Refuse instead of answering it.
    if (customFrom !== null && customTo !== null && customFrom > customTo) {
      throw new HttpError('VALIDATION_FAILED', 'from must not be after to');
    }
    // 'a' (all time) returns from=0; the strict `gte 0` predicate keeps the
    // SQL stable across periods so the planner's index pick doesn't shift.
    const fromDate = customFrom ?? (period === 'a' ? null : from);
    const windowTo = customTo ?? to;

    const filtered = q.symbol !== undefined || q.exitIntent !== undefined || q.source !== undefined;
    // The indexed walk serves only its own ordering, on the whole period, in one direction. Every other request orders the period set in memory, which is already read for the rollups — so a filter or a derived key costs no extra query, only the loss of keyset paging.
    const keyset = !filtered && sort === 'archivedAt' && dir === 'desc' && customTo === null;

    const tag = sequenceTag(q);
    let cursorObj: { archivedAt: string; id: string } | null = null;
    let offset = 0;
    if (cursor !== undefined) {
      const offsetParts = OFFSET_CURSOR.exec(cursor);
      if (keyset) {
        // A cursor from the offset walk cannot address a row here, and silently starting from the top would re-serve page 1 as though it were page 3.
        if (offsetParts !== null) {
          throw new HttpError('VALIDATION_FAILED', 'cursor was minted under a different ordering');
        }
        // `ArchiveCursor` has already proven both halves and the separator, so the split cannot fail here.
        const { timestamp, id } = splitCompositeCursor(cursor, CURSOR_SEPARATOR);
        cursorObj = { archivedAt: timestamp, id };
      } else {
        // The offset is only meaningful in the sequence it was taken in; the tag is what lets a re-sort OR a re-filter be refused rather than silently mis-paged.
        if (offsetParts === null || offsetParts[1] !== tag) {
          throw new HttpError('VALIDATION_FAILED', 'cursor was minted under a different ordering');
        }
        offset = Number(offsetParts[2]);
      }
    }

    // Resolved before the transaction opens: `userIdOf` throws 401 when the request carries no session, `accountIdOf` throws 404 on a malformed `:accountId`, and a request that was always going to fail on either should not first open a BEGIN and take a pooled connection with it.
    const operatorId = userIdOf(c);
    const accountId = accountIdOf(c);

    // One transaction on one pooled connection, reads issued in sequence. Run concurrently they took a connection each, so three of these page loads in flight held the whole api pool of ten and every other route queued behind them — and until a read carries an execution budget, "queued behind" has no end. The trade is latency: concurrent cost this page its slowest read, serial costs the sum of all four. A page that renders a little later, against a pool one screen can no longer empty.
    // The ownership check is minted inside the transaction so it runs on that same connection. `ProfileNotOwnedError` still surfaces as a 404: drizzle rolls the transaction back and rethrows the original error, not a wrapper.
    // The by-intent rollup is period-scoped (every trade in the window, not just this page), so it reads the full period separately from the paged list. The archive is small enough per profile to read unpaginated.
    // The rollup branch lives INSIDE this callback rather than around it: `withStatementTimeout` refuses a transaction handle, so a second wrapper for the rollup path would either nest a SAVEPOINT whose budget leaks into the rest of the transaction, or open a second pooled connection for the same request.
    const rollupOnly = view === 'rollup';
    const { pageRows, recoverableSymbols, rawUnreconstructable, periodRows } =
      await withStatementTimeout(di.db, ARCHIVE_READ_BUDGET_MS, async (tx) => {
        const p = await profileRepo(tx, operatorId, accountId, profileId);
        const pageRows =
          rollupOnly || !keyset
            ? undefined
            : await p.tradeArchive.listForProfilePaginated(limit, fromDate, cursorObj);
        const recoverableSymbols = rollupOnly
          ? undefined
          : await p.tradeArchive.listRecoverableSymbols();
        const rawUnreconstructable = rollupOnly
          ? undefined
          : await p.tradeArchive.listUnreconstructableSymbols();
        const periodRows = await p.tradeArchive.listForProfileInRange(fromDate, customTo);
        return { pageRows, recoverableSymbols, rawUnreconstructable, periodRows };
      });
    const unreconstructableSymbols = rawUnreconstructable?.map((u) => ({
      symbol: u.symbol,
      reason: unreconstructableReason(u),
      dismissed: u.dismissed,
    }));
    // One projection feeds both rollups: by exit intent (why each trade closed)
    // and by where the binding came from (auto = discovery, manual = operator-added, unknown = bot-recovered).
    // Built off the whole period whatever the row filters are: the rollups are the operator's map, and a map redrawn to show only where they already clicked cannot be navigated back out of.
    const rollupItems = periodRows.map((r) => ({
      quoteAsset: r.quoteAsset,
      source: r.source,
      profit: asDecimalString(r.profit),
      feesQuote: asDecimalString(r.feesQuote),
      feeBasis: r.feeBasis,
      orders: coerceArchivedOrders(r.orders),
    }));
    const byIntent = rollupByExitIntent(rollupItems);
    const bySource = rollupBySource(rollupItems);

    let items: ArchiveItem[] | undefined;
    let nextCursor: string | null | undefined;
    if (rollupOnly) {
      // Undefined rather than null when no page was read: null is this route's "end of stream", which a response that never walked the archive cannot assert.
      items = undefined;
      nextCursor = undefined;
    } else if (pageRows !== undefined) {
      items = pageRows.map(archiveItem);
      const last = pageRows.at(-1);
      // `cursorToken`, not `archivedAt.toISOString()`: the row's `archivedAt` has already lost its microseconds to the driver's `Date`, and a boundary emitted at that reduced precision strands every row sharing its millisecond.
      nextCursor =
        pageRows.length === limit && last !== undefined
          ? `${last.cursorToken}${CURSOR_SEPARATOR}${last.id}`
          : null;
    } else {
      const matching = selectArchiveItems(periodRows, q);
      items = matching.slice(offset, offset + limit);
      // Off the total, not off the page length: a full page is not evidence of a next one, and the total is already in hand here.
      nextCursor = offset + limit < matching.length ? `${tag}:${offset + limit}` : null;
    }

    return c.json(
      {
        items,
        nextCursor,
        recoverableSymbols,
        unreconstructableSymbols,
        byIntent,
        bySource,
        // The resolved window, not the token: every surface reading these rollups plots the same period, and only the server knows where the operator's timezone cut it.
        from: (fromDate ?? new Date(0)).toISOString(),
        to: windowTo.toISOString(),
      },
      200,
    );
  });

  // Registered before the `{archiveId}` route so `/export` is matched as the literal it is. `archiveId` is a uuid, so the detail route would answer `/export` with a 422 rather than the file — a difference the operator would see as a broken download button, with a validation error in the body explaining a path they never typed.
  app.openapi(exportRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const q = c.req.valid('query');
    const { from, to } = periodWindow(q.period, q.tz, new Date());
    const customFrom = q.from === undefined ? null : new Date(q.from);
    const customTo = q.to === undefined ? null : new Date(q.to);
    if (customFrom !== null && customTo !== null && customFrom > customTo) {
      throw new HttpError('VALIDATION_FAILED', 'from must not be after to');
    }
    const fromDate = customFrom ?? (q.period === 'a' ? null : from);
    // Same execution budget the list route puts on this same read, for the same reason: `listForProfileInRange` is unpaginated by design, and an export defaults to the whole archive because `period` defaults to 'a' and `to` is optional. Without it a handful of concurrent exports hold the api pool's ten connections for as long as Postgres will run the query, which is forever, and every other route queues behind them until its checkout deadline turns into a 503. Resolved before the transaction opens so a missing session or a malformed `:accountId` fails without first taking a connection, matching the list route above.
    // The reads sit inside one transaction and the streaming callback stays outside it: `stream()` outlives the handler, so writing from inside would hold the connection for the length of the client's download rather than the length of the query.
    const operatorId = userIdOf(c);
    const accountId = accountIdOf(c);
    const { profile, rows } = await withStatementTimeout(
      di.db,
      ARCHIVE_READ_BUDGET_MS,
      async (tx) => {
        const p = await profileRepo(tx, operatorId, accountId, profileId);
        return {
          profile: await p.profile.findById(),
          rows: await p.tradeArchive.listForProfileInRange(fromDate, customTo),
        };
      },
    );
    const items = selectArchiveItems(rows, q);
    c.header('content-type', 'application/x-ndjson');
    // Sanitise before interpolating: a stray quote or CR/LF in a profile name would break, or inject into, the header.
    const safeName = (profile?.name ?? 'profile').replace(/[^A-Za-z0-9._-]/g, '_');
    c.header('content-disposition', `attachment; filename="trades-${safeName}.ndjson"`);
    c.set('auditEvent', {
      event: 'export-trade-archive',
      payload: {
        profileId,
        from: (fromDate ?? new Date(0)).toISOString(),
        to: (customTo ?? to).toISOString(),
        rows: items.length,
      },
    });
    return stream(
      c,
      async (st) => {
        // Already materialised: this is the same whole-period read the rollups run on, so there is no page to walk and no second query to reconcile against. The cap still applies, because "small per profile" is a fact about today's data, not a constraint the schema enforces.
        for (const item of items.slice(0, EXPORT_MAX_ROWS)) {
          await st.write(`${JSON.stringify(item)}\n`);
        }
        if (items.length > EXPORT_MAX_ROWS) {
          // Say so in-band. A silently truncated export reads as a complete one, and the operator would conclude the missing cycles never happened.
          await st.write(
            `${JSON.stringify({ truncated: true, written: EXPORT_MAX_ROWS, limit: EXPORT_MAX_ROWS })}\n`,
          );
        }
      },
      async (e, st) => {
        // Without this arm hono swallows the throw and closes the stream cleanly, so a half-written file arrives as a complete HTTP 200. The headers are long gone, so the only channels left are an in-band marker and aborting the transfer.
        await st.write(`${JSON.stringify({ error: 'EXPORT_FAILED', reason: e.message })}\n`);
        await st.close();
      },
    );
  });

  app.openapi(detailRoute, async (c) => {
    const { profileId: rawProfileId, archiveId } = c.req.valid('param');
    const profileId = asProfileId(rawProfileId);
    const p = await scopeOf(c, di, profileId);
    const row = await p.tradeArchive.findById(archiveId);
    // 404 rather than an empty order list: a row this profile does not own and a row that does not exist must be indistinguishable, and an empty `orders` is a real state of an existing row.
    if (row === null) throw new HttpError('NOT_FOUND', `archive entry ${archiveId}`);
    return c.json({ id: row.id, orders: coerceArchivedOrderDetails(row.orders) }, 200);
  });

  app.openapi(backfillRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    // Binance symbols are upper-case and case-sensitive; the Redis symbol-info
    // key and myTrades query are built from the literal string. Normalise here
    // so a direct API caller (the web client already upper-cases) can't enqueue
    // a job that silently finds no trades or throws on a cold cache forever.
    const symbol = c.req.valid('param').symbol.toUpperCase();
    const { from, to } = c.req.valid('json');
    const p = await scopeOf(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    const scheduledAt = new Date();
    await di.queue.add(
      'backfill-trade-archive',
      {
        userId: operatorId,
        accountId,
        profileId,
        symbol,
        fromMs: from !== undefined ? new Date(from).getTime() : null,
        toMs: to !== undefined ? new Date(to).getTime() : null,
      },
      { jobId: `backfill-archive:${profileId}:${symbol}:${scheduledAt.getTime()}` },
    );
    c.set('auditEvent', {
      event: 'backfill-trade-archive',
      payload: { profileId, symbol, from: from ?? null, to: to ?? null },
    });
    return c.json({ scheduledAt: scheduledAt.toISOString() }, 202);
  });

  app.openapi(dismissRoute, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const symbol = c.req.valid('param').symbol.toUpperCase();
    const { dismissed } = c.req.valid('json');
    const p = await scopeOf(c, di, profileId);
    await p.tradeArchive.setUnreconstructableDismissed(symbol, dismissed);
    c.set('auditEvent', {
      event: 'unreconstructable-dismiss',
      payload: { profileId, symbol, dismissed },
    });
    return c.json({ dismissed }, 200);
  });

  return app;
};
