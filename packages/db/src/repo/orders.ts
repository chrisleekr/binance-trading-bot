import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { accounts } from '../schema/accounts.js';
import { orders, type OrderInsert, type OrderRow } from '../schema/orders.js';
import type { AccountId, UserId } from '@app/contracts';
import type { Database } from './_db.js';
import type { AccountScope, ProfileScope } from './_scoped.js';

/**
 * Every live order's `binanceOrderId` tagged with the ACCOUNT that owns it and
 * that account's Binance mode (db-first global, symbol-agnostic). The
 * orphan-detection cron and the adopt route diff each Binance account's open
 * orders only against the ids tracked for THAT account: order ids are unique per
 * Binance account, so two accounts' ids can coincide and a single global set
 * would let one mask the other's orphan (or false-block its adopt).
 *
 * Reads `orders.account_id` directly. Joining through `profiles` would silently
 * drop every DETACHED row (profile_id NULL after a profile delete) — exactly the
 * still-resting orders the orphan sweep exists to surface.
 */
export async function listLiveBinanceOrderIdsByAccount(
  db: Database,
): Promise<{ binanceOrderId: bigint; accountId: AccountId; mode: 'test' | 'live' }[]> {
  const rows = await db
    .select({
      binanceOrderId: orders.binanceOrderId,
      accountId: orders.accountId,
      mode: accounts.binanceMode,
    })
    .from(orders)
    .innerJoin(accounts, eq(orders.accountId, accounts.id))
    .where(isNull(orders.closedAt));
  return rows.map((r) => ({
    binanceOrderId: r.binanceOrderId,
    accountId: r.accountId as AccountId,
    mode: r.mode as 'test' | 'live',
  }));
}

/**
 * Every still-open DETACHED order — `profile_id NULL`, i.e. its profile was
 * deleted — tagged with the account that holds the key pair and the operator who
 * owns that account.
 *
 * GLOBAL (db-first) on purpose, and it is the ONLY way these rows are reachable.
 * Deleting an account's last profile both detaches its orders AND tears down the
 * only user-data stream the account had, so every profile-driven sweep (the boot
 * reaper, the orphan cron) is structurally blind to them: they iterate the active
 * profile set, and there is none. Left unreconciled the row stays `closed_at
 * NULL` forever — permanent phantom exposure that blocks the account delete it
 * was created by.
 */
export async function listLiveDetached(db: Database): Promise<
  {
    binanceOrderId: bigint;
    accountId: AccountId;
    operatorId: UserId;
    symbol: string;
    status: string;
  }[]
> {
  const rows = await db
    .select({
      binanceOrderId: orders.binanceOrderId,
      accountId: orders.accountId,
      operatorId: accounts.ownerId,
      symbol: orders.symbol,
      status: orders.status,
    })
    .from(orders)
    .innerJoin(accounts, eq(orders.accountId, accounts.id))
    .where(and(isNull(orders.profileId), isNull(orders.closedAt)));
  return rows.map((r) => ({
    binanceOrderId: r.binanceOrderId,
    accountId: r.accountId as AccountId,
    operatorId: r.operatorId as UserId,
    symbol: r.symbol,
    status: r.status,
  }));
}

export async function listLiveForSymbol(scope: ProfileScope, symbol: string): Promise<OrderRow[]> {
  return scope.db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.profileId, scope.profileId),
        eq(orders.symbol, symbol),
        isNull(orders.closedAt),
      ),
    );
}

/**
 * Batched {@link listLiveForSymbol}: every live order across `symbols` for the
 * profile, in one query. The dashboard projections group the rows by symbol
 * instead of issuing one query per symbol (the cross-profile home screen's
 * N+1). Empty `symbols` short-circuits to `[]` (avoids a no-op round-trip).
 */
export async function listLiveForSymbols(
  scope: ProfileScope,
  symbols: readonly string[],
): Promise<OrderRow[]> {
  if (symbols.length === 0) return [];
  return scope.db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.profileId, scope.profileId),
        inArray(orders.symbol, [...symbols]),
        isNull(orders.closedAt),
      ),
    );
}

/**
 * Every live order for the profile, across all symbols (no `profile_symbols`
 * join). The delete-profile guard reads this so a resting order on a symbol
 * discovery already rotated out still blocks the destructive wipe — the
 * symbol-scoped {@link listLiveForSymbols} would miss it.
 */
export async function listLiveForProfile(scope: ProfileScope): Promise<OrderRow[]> {
  return scope.db
    .select()
    .from(orders)
    .where(and(eq(orders.profileId, scope.profileId), isNull(orders.closedAt)));
}

/**
 * Among a set of Binance order ids, the `(symbol, binanceOrderId)` of every one this
 * profile RECORDED — with NO `closed_at` filter. A profile disposal reads this to prove
 * ownership of an order still on the exchange, next to the strategy's own id attribution.
 *
 * Deliberately closed-blind: `upsertLive`'s `closePrevious` stamps the previous
 * `(profile, symbol, intent)` row CLOSED the moment the next candle's order takes the
 * slot, while the superseded order may still be RESTING on Binance. A `closed_at IS NULL`
 * filter would fail to claim exactly that resting order, the row that proves it is ours.
 *
 * Matches SOLELY on `symbol` + `binance_order_id`. `binance_order_id` is NOT NULL on every
 * write path, and a Binance orderId is unique per SYMBOL (not per account), so the pair is
 * an exact identity for an order on the account's book. `client_order_id` is not matched:
 * Binance frees it once the order leaves the book, so a recycled string could claim a
 * stranger's order.
 *
 * Empty `binanceOrderIds` short-circuits to `[]`: an empty id set matches nothing, and
 * asking would otherwise be a full-table scan for no candidates.
 *
 * The id set is an OR of `eq`, not `inArray`: `eq` runs each value through the column's
 * driver mapper (so a `bigint`-mode value reaches the wire as int8 text) while `inArray`
 * does not map its elements. The open-order book is a handful of rows, so the OR is a
 * bitmap index scan.
 */
export async function listRecordedAmong(
  scope: ProfileScope,
  binanceOrderIds: readonly bigint[],
): Promise<{ symbol: string; binanceOrderId: bigint }[]> {
  if (binanceOrderIds.length === 0) return [];
  return scope.db
    .select({ symbol: orders.symbol, binanceOrderId: orders.binanceOrderId })
    .from(orders)
    .where(
      and(
        eq(orders.accountId, scope.accountId),
        eq(orders.profileId, scope.profileId),
        or(...binanceOrderIds.map((id) => eq(orders.binanceOrderId, id))),
      ),
    );
}

/**
 * One local `orders` row claiming a reconstructed closing Binance order ID, carrying exactly the fields the recovery attributor checks before it will copy an intent onto an archived cycle.
 *
 * `executedQty` is null both when the column holds no executed quantity AND when it holds a JSON number, which is why the attributor treats null as "quantity unproven" rather than "quantity zero": a number has already been through IEEE-754 and can no longer be compared for exact decimal equality.
 */
export interface RecoveryAttributionRow {
  readonly binanceOrderId: bigint;
  readonly intent: string;
  readonly side: string;
  readonly status: string;
  readonly closedAt: Date | null;
  readonly executedQty: string | null;
}

/**
 * Ids per statement. The caller's batch is one closing order per reconstructed round-trip over a symbol's ENTIRE Binance history, so it is bounded by the operator's lifetime trade count and by nothing in the code. Each id costs one bind parameter, and Postgres encodes a Bind message's parameter count as an Int16, so a single statement dies past 65535; long before that, a several-thousand-term OR is a planner cost this repo has already been bitten by. Chunking lives here, not at the call site, so every caller inherits the bound.
 */
const ATTRIBUTION_ID_CHUNK = 500;

/**
 * Returns every local identity row for reconstructed closing order IDs. The caller must reject ambiguous identities before validating terminal state, intent, and quantity.
 *
 * The id set is an OR of `eq`, not `inArray`, for the reason {@link listRecordedAmong} states: `eq` runs each value through the column's `bigint`-mode driver mapper and `inArray` does not, so collapsing this to `inArray` silently stops matching. Large batches are chunked rather than widened.
 *
 * `executedQty` surfaces only when `raw.executedQty` is a JSON string. A JSON number has already been through IEEE-754 and can no longer be trusted to be the exact decimal the caller's quantity check compares, so it is reported as absent rather than cast into a false match.
 *
 * @param scope - Ownership-proven account and profile scope.
 * @param symbol - Symbol reconstructed from Binance trade history.
 * @param binanceOrderIds - Closing Binance order IDs present in the recovery batch.
 * @returns Rows within the exact account, profile, symbol, and order-ID set, with executed quantity exposed only when stored as a JSON string.
 */
export async function listRecoveryAttributionRows(
  scope: ProfileScope,
  symbol: string,
  binanceOrderIds: readonly bigint[],
): Promise<RecoveryAttributionRow[]> {
  if (binanceOrderIds.length === 0) return [];
  // Deduped here rather than trusted from the caller: a repeated id inside one chunk matches its row once, but split across two chunks it comes back twice, and the caller cannot tell that from two local rows genuinely claiming one exchange order. It would report a chunking artifact as a data-integrity anomaly.
  const uniqueIds = [...new Set(binanceOrderIds)];
  const rows: RecoveryAttributionRow[] = [];
  for (let i = 0; i < uniqueIds.length; i += ATTRIBUTION_ID_CHUNK) {
    const chunk = uniqueIds.slice(i, i + ATTRIBUTION_ID_CHUNK);
    rows.push(
      ...(await scope.db
        .select({
          binanceOrderId: orders.binanceOrderId,
          intent: orders.intent,
          side: orders.side,
          status: orders.status,
          closedAt: orders.closedAt,
          executedQty: sql<
            string | null
          >`case when jsonb_typeof(${orders.raw} -> 'executedQty') = 'string' then ${orders.raw} ->> 'executedQty' else null end`,
        })
        .from(orders)
        .where(
          and(
            eq(orders.accountId, scope.accountId),
            eq(orders.profileId, scope.profileId),
            eq(orders.symbol, symbol),
            or(...chunk.map((id) => eq(orders.binanceOrderId, id))),
          ),
        )),
    );
  }
  return rows;
}

export async function listHistoryForSymbol(
  scope: ProfileScope,
  symbol: string,
  limit: number,
): Promise<OrderRow[]> {
  return scope.db
    .select()
    .from(orders)
    .where(and(eq(orders.profileId, scope.profileId), eq(orders.symbol, symbol)))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

export async function findLive(
  scope: ProfileScope,
  symbol: string,
  intent: string,
): Promise<OrderRow | null> {
  const rows = await scope.db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.profileId, scope.profileId),
        eq(orders.symbol, symbol),
        eq(orders.intent, intent),
        isNull(orders.closedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listHistory(
  scope: ProfileScope,
  symbol: string,
  intent: string,
  limit: number,
): Promise<OrderRow[]> {
  return scope.db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.profileId, scope.profileId),
        eq(orders.symbol, symbol),
        eq(orders.intent, intent),
      ),
    )
    .orderBy(desc(orders.closedAt))
    .limit(limit);
}

/** Column set a caller supplies; the owning account and profile come off the scope. */
export type OrderInput = Omit<OrderInsert, 'profileId' | 'accountId'>;

export async function insert(scope: ProfileScope, input: OrderInput): Promise<OrderRow> {
  const [row] = await scope.db
    .insert(orders)
    .values({ ...input, accountId: scope.accountId, profileId: scope.profileId })
    .returning();
  if (!row) throw new Error('orders.insert: insert returned no rows');
  return row;
}

/**
 * The intent a recovery row is written under. NOT the strategy's own intent: the
 * strategy's live slot `(profile_id, symbol, intent) WHERE closed_at IS NULL` is
 * very often ALREADY HELD when we get here — a still-resting previous order is the
 * single most common reason the normal write failed — and an insert on the held
 * slot is exactly the write that gets swallowed, leaving the live order with no
 * local trace at all.
 *
 * So the recovery row takes a reserved intent that no strategy can emit and that is
 * unique per exchange order, which makes it collision-free by construction while
 * keeping the row FULLY VISIBLE where it matters: the orphan sweep and the account
 * exposure guard read `orders.account_id` / `closed_at` (intent-blind), and the fill
 * adopter seeks by `(account, binance_order_id)`. Only the strategy's own slot
 * lookups — which must keep pointing at the still-resting order — are excluded, and
 * that is the point.
 */
export const untrackedIntent = (intent: string, binanceOrderId: bigint): string =>
  `${intent}:untracked:${binanceOrderId}`;

/**
 * Plain insert of a row for an order that IS (or may be) live on Binance but whose
 * normal bookkeeping failed — the exchange accepted the placement and the write
 * that should have recorded it did not land, or a probe found an order we had
 * given up on. Without this the order rests on the exchange with no local row at
 * all: invisible to the operator, unreconcilable by the user-data stream, and only
 * ever surfaced as an orphan.
 *
 * Deliberately NOT `upsertLive`: it must never close the row already holding the
 * live slot (that row may itself still be resting). It writes under
 * {@link untrackedIntent} instead, so it never contends for that slot.
 *
 * The conflict target is stated EXPLICITLY. A bare `onConflictDoNothing()` lets
 * Postgres infer every arbiter index, which made the live-slot index the arbiter
 * and silently swallowed precisely the recovery this function exists for. With the
 * target named, the only conflict that can fire is this same order being recorded
 * twice — the idempotency we do want.
 *
 * That idempotency holds only WHILE THE ROW IS OPEN: the arbiter is the partial index
 * `WHERE closed_at IS NULL`, so a TERMINAL row (a probed MARKET order, already FILLED)
 * is outside the predicate, no conflict can fire, and a second call would insert a
 * duplicate. No caller invokes it twice for one order, so this is a bound on the
 * guarantee, not a live defect — but do not lean on it as a general upsert.
 */
export async function insertTracking(scope: ProfileScope, input: OrderInput): Promise<void> {
  await scope.db
    .insert(orders)
    .values({
      ...input,
      intent: untrackedIntent(input.intent, input.binanceOrderId),
      accountId: scope.accountId,
      profileId: scope.profileId,
    })
    // `where` here is the ARBITER's index predicate (drizzle's name for
    // Postgres's `index_predicate`), which is what makes the partial live-slot
    // index inferable — not a row filter.
    .onConflictDoNothing({
      target: [orders.profileId, orders.symbol, orders.intent],
      where: isNull(orders.closedAt),
    });
}

/** Thrown by {@link upsertLive} when the live slot is held and closing it is unsafe. */
export class LiveSlotOccupiedError extends Error {
  constructor(
    public readonly symbol: string,
    public readonly intent: string,
  ) {
    super(
      `orders.upsertLive: live slot ${symbol}/${intent} is occupied and the previous order ` +
        `could not be confirmed cancelled`,
    );
    this.name = 'LiveSlotOccupiedError';
  }
}

/**
 * Idempotent live-order placement against the
 * `orders_one_live_per_intent (profile_id, symbol, intent) WHERE closed_at
 * IS NULL` partial unique index. A LIMIT/stop order that is still resting
 * on the exchange holds the live slot for its `(symbol, intent)`; a naive
 * second `insert` on the same slot throws the unique violation. So in one
 * transaction: close any stale live row for the slot (status=CANCELED,
 * closed_at=now), then insert the replacement.
 *
 * Only non-terminal (still-live) rows need this: a terminal-status row
 * (FILLED MARKET, etc.) lands `closed_at` non-null and so never contends
 * for the live slot, so the plain `insert` suffices for those.
 *
 * Races with the user-stream: a resting order can fill on Binance between
 * its placement and the next tick. If this slot-reuse closes that still-`NEW`
 * row as CANCELED before the fill is processed, the row is briefly wrong — but
 * {@link markFilledByBinanceOrderId} reclaims it to FILLED on the fill (it
 * matches by `binanceOrderId` with no `closed_at` guard), so a truly-filled
 * order never stays CANCELED. The CANCELED stamp here is correct for the common
 * case (a genuinely-superseded resting rung) and self-corrects for the fill.
 *
 * `closePrevious` is the caller's assertion that the previous order is provably
 * gone from the exchange (its cancel succeeded, or there was nothing to cancel).
 * When it is `false` the previous order may still be RESTING on Binance, so
 * stamping its row CANCELED would be a lie that mints an orphan — two live orders,
 * one bogus record. This throws {@link LiveSlotOccupiedError} instead; the caller
 * must not have placed the new order at all.
 */
export async function upsertLive(
  scope: ProfileScope,
  input: OrderInput,
  options: { readonly closePrevious: boolean },
): Promise<OrderRow> {
  return scope.db.transaction(async (tx) => {
    const slot = and(
      eq(orders.profileId, scope.profileId),
      eq(orders.symbol, input.symbol),
      eq(orders.intent, input.intent),
      isNull(orders.closedAt),
    );
    if (options.closePrevious) {
      await tx.update(orders).set({ status: 'CANCELED', closedAt: new Date() }).where(slot);
    } else {
      const held = await tx.select({ id: orders.id }).from(orders).where(slot).limit(1);
      if (held.length > 0) throw new LiveSlotOccupiedError(input.symbol, input.intent);
    }
    const [row] = await tx
      .insert(orders)
      .values({ ...input, accountId: scope.accountId, profileId: scope.profileId })
      .returning();
    if (!row) throw new Error('orders.upsertLive: insert returned no rows');
    return row;
  });
}

export async function close(
  scope: ProfileScope,
  symbol: string,
  intent: string,
  status: string,
): Promise<void> {
  await scope.db
    .update(orders)
    .set({ status, closedAt: new Date() })
    .where(
      and(
        eq(orders.profileId, scope.profileId),
        eq(orders.symbol, symbol),
        eq(orders.intent, intent),
        isNull(orders.closedAt),
      ),
    );
}

/**
 * Lookup by the internal `orders.id` UUID. The api's cancel-order route
 * sends the local row id (not the Binance numeric id), so the pipeline
 * handler can resolve it back to `(symbol, binance_order_id)` before
 * driving the executor. Scoped by `profileId` so a caller holding a
 * stale or cross-tenant id never strays outside owned rows.
 */
export async function findById(scope: ProfileScope, id: string): Promise<OrderRow | null> {
  const rows = await scope.db
    .select()
    .from(orders)
    .where(and(eq(orders.profileId, scope.profileId), eq(orders.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Lookup by Binance's numeric `orderId`. The executor's cancel path is
 * driven by `decision.orderId` (a Binance id, not our internal uuid), so
 * resolving back to `(symbol, intent)` for the open-orders Redis cleanup
 * has to seek on `binance_order_id` rather than the primary key.
 *
 * Returns `null` when no row matches inside the account scope — the
 * executor treats a miss as "order not in our books" and refuses the
 * cancel rather than guessing.
 *
 * ACCOUNT-scoped, like every other seek-by-Binance-id below: a Binance order id
 * is unique per ACCOUNT (not per profile), the user-data stream that drives these
 * lookups is per account, and a DETACHED row (profile_id NULL) is reachable ONLY
 * by account. Narrowing to the profile would make a detached but still-resting
 * order unreconcilable.
 */
export async function findByBinanceOrderId(
  scope: AccountScope,
  binanceOrderId: bigint,
): Promise<OrderRow | null> {
  const rows = await scope.db
    .select()
    .from(orders)
    .where(and(eq(orders.accountId, scope.accountId), eq(orders.binanceOrderId, binanceOrderId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Closes the live row keyed by Binance's numeric `orderId`. Used when the
 * user-stream pool reports a fill/cancel: the WS frame carries the Binance
 * id, not our `(symbol, intent)` tuple, so we close by id to keep the
 * close idempotent against a concurrent placement on the same intent slot.
 *
 * Returns the number of rows actually closed so callers can detect a
 * mismatch (zero rows = the id was never tracked, or was already closed
 * by a prior event) instead of silently no-op-ing.
 */
export async function closeByBinanceOrderId(
  scope: AccountScope,
  binanceOrderId: bigint,
  status: string,
  // Epoch-ms from the producer that observed the close. Optional so
  // callers without a meaningful timestamp can still close a row; the
  // wall-clock fallback keeps `closed_at` non-null in that case.
  closedAtMs?: number,
  // Fresh exchange snapshot to overwrite `raw` with. Supplied only when the
  // close reconciles a stale snapshot (the cancel-vs-fill -2011 path queries
  // the order's true terminal state), so `raw.executedQty`/`status` become
  // truthful. Omitted on the common path, leaving the placement-time `raw`
  // intact.
  raw?: unknown,
): Promise<number> {
  const closedAt =
    typeof closedAtMs === 'number' && Number.isFinite(closedAtMs)
      ? new Date(closedAtMs)
      : new Date();
  const closed = await scope.db
    .update(orders)
    .set(raw === undefined ? { status, closedAt } : { status, closedAt, raw })
    .where(
      and(
        eq(orders.accountId, scope.accountId),
        eq(orders.binanceOrderId, binanceOrderId),
        isNull(orders.closedAt),
      ),
    )
    .returning({ id: orders.id });
  return closed.length;
}

/**
 * Reconcile a row to FILLED by Binance `orderId` after a user-stream fill. `place-order` inserts only immediate (MARKET) fills as FILLED; a resting LIMIT or STOP_LOSS_LIMIT is inserted `NEW` and, without this, stays `NEW` until {@link upsertLive} reuses its `(symbol, intent)` slot and clobbers it to CANCELED — a filled order recorded as a cancellation, and (because the archive reads `raw->>'cummulativeQuoteQty'`) a zeroed cost basis that inflates realised P/L.
 *
 * Three call-site invariants the signature cannot carry. It matches WITHOUT a `closed_at IS NULL` guard on purpose, so it reclaims a row a racing `upsertLive` already closed as CANCELED: the fill is ground truth and a wrongly-CANCELED row must yield to it. It is safe to call ONLY from a FILLED executionReport — a truly-canceled order never emits one, so forcing the row to FILLED here is always correct. And, like {@link closeByBinanceOrderId} / {@link findByBinanceOrderId}, it rests on `binance_order_id` being unique within a profile (every placement gets a fresh Binance id; no path reuses one), which is what makes the unguarded `UPDATE` patch exactly one row.
 *
 * Idempotent: the `status <> 'FILLED'` predicate makes a Binance executionReport replay a no-op. Merges the fill totals into `raw` with a top-level `||`, preserving `clientOrderId` / `transactTime` / `fills`, so the archive's cost basis stays truthful.
 *
 * @param scope - Ownership-proven account scope containing the order.
 * @param binanceOrderId - Binance identity of the filled order.
 * @param fill - Final exchange totals.
 * @param closedAtMs - Fill time in epoch milliseconds; current time is used when the producer has no meaningful timestamp.
 * @returns The number of rows whose status changed; zero means already FILLED or untracked.
 */
export async function markFilledByBinanceOrderId(
  scope: AccountScope,
  binanceOrderId: bigint,
  fill: { readonly executedQty: string; readonly cummulativeQuoteQty: string },
  // Epoch-ms of the fill. Optional; the wall-clock fallback keeps `closed_at`
  // non-null and is within seconds of the real fill on the live path. It is
  // reconcile-time, not fill-time, so a fill reconciled long after the fact
  // (worker restart / stream replay) can bucket at an archive-window edge by
  // reconcile time; the live path closes within seconds so this is immaterial.
  closedAtMs?: number,
): Promise<number> {
  const closedAt =
    typeof closedAtMs === 'number' && Number.isFinite(closedAtMs)
      ? new Date(closedAtMs)
      : new Date();
  const updated = await scope.db
    .update(orders)
    .set({
      status: 'FILLED',
      closedAt,
      raw: sql`coalesce(${orders.raw}, '{}'::jsonb) || jsonb_build_object('status', 'FILLED', 'executedQty', ${fill.executedQty}::text, 'cummulativeQuoteQty', ${fill.cummulativeQuoteQty}::text)`,
    })
    .where(
      and(
        eq(orders.accountId, scope.accountId),
        eq(orders.binanceOrderId, binanceOrderId),
        sql`${orders.status} <> 'FILLED'`,
      ),
    )
    .returning({ id: orders.id });
  return updated.length;
}

/**
 * Record the exact base-asset BUY commission already removed from cost-basis quantity. Keeping this write in the fill transaction prevents the position and its later fee evidence from diverging.
 *
 * @param scope - Ownership-proven profile scope containing the order.
 * @param symbol - Binance symbol, required because order ids are symbol-scoped.
 * @param binanceOrderId - Binance identity of the filled BUY order.
 * @param amount - Cumulative base-asset commission removed from the adopted quantity.
 * @returns The number of matching BUY rows stamped; zero means the tracked row was absent.
 */
export async function stampBaseCommissionNetted(
  scope: ProfileScope,
  symbol: string,
  binanceOrderId: bigint,
  amount: string,
): Promise<number> {
  const updated = await scope.db
    .update(orders)
    .set({ baseCommissionNetted: amount })
    .where(
      and(
        eq(orders.accountId, scope.accountId),
        eq(orders.profileId, scope.profileId),
        eq(orders.symbol, symbol),
        eq(orders.binanceOrderId, binanceOrderId),
        eq(orders.side, 'BUY'),
      ),
    )
    .returning({ id: orders.id });
  return updated.length;
}

/**
 * Stamp cost-basis-matched realised P/L (`realizedPnlOnSell`) onto a SELL order
 * row, idempotently and INDEPENDENT of status. Separate from
 * {@link markFilledByBinanceOrderId} on purpose: a MARKET sell is inserted
 * already-`FILLED` by `place-order` (Binance's FULL response carries the
 * status), so that function's `status <> 'FILLED'` flip never matches it — yet
 * the archive still needs its realised P/L. This update has no status guard, so
 * it stamps both the async resting fill (NEW→FILLED) and the synchronous MARKET
 * fill. The `realized_pnl IS NULL` predicate makes it write-once: a replay or a
 * boot reclaim racing the user-stream never overwrites an existing value, and
 * it never touches `status` / `closed_at` / `raw`, so it cannot move a row's
 * archive-window bucket. Returns the number of rows stamped (0 if the row is
 * absent or already carries a value).
 */
export async function stampRealizedPnl(
  scope: AccountScope,
  binanceOrderId: bigint,
  realized: { readonly realizedPnl: string; readonly costBasisQuote: string },
): Promise<number> {
  const updated = await scope.db
    .update(orders)
    .set({ realizedPnl: realized.realizedPnl, costBasisQuote: realized.costBasisQuote })
    .where(
      and(
        eq(orders.accountId, scope.accountId),
        eq(orders.binanceOrderId, binanceOrderId),
        eq(orders.side, 'SELL'),
        isNull(orders.realizedPnl),
      ),
    )
    .returning({ id: orders.id });
  return updated.length;
}

/**
 * Reaps a live order row, stamping a structured `cancelReason` into `raw`
 * so post-hoc analysis can distinguish reaper-driven closures (the order
 * was never on the exchange) from real cancels driven by the worker's
 * cancel handler. Idempotent: if the row was already closed by a
 * concurrent path the update is a no-op and returns 0.
 */
export async function reapWithReason(
  scope: AccountScope,
  binanceOrderId: bigint,
  status: string,
  reason: string,
): Promise<number> {
  const closed = await scope.db
    .update(orders)
    .set({
      status,
      closedAt: new Date(),
      raw: sql`jsonb_set(coalesce(${orders.raw}, '{}'::jsonb), '{cancelReason}', to_jsonb(${reason}::text), true)`,
    })
    .where(
      and(
        eq(orders.accountId, scope.accountId),
        eq(orders.binanceOrderId, binanceOrderId),
        isNull(orders.closedAt),
      ),
    )
    .returning({ id: orders.id });
  return closed.length;
}
