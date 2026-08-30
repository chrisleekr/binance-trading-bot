// Per-profile write helpers consumed by `ProfileExecutorBindings`.
//
// The executor calls `bindings.persistence.persistOrder(row)` etc. without knowing
// which profile it operates on (it's already scoped via the bindings).
// These helpers close over a `ProfileRepo` so the executor's callsites
// stay free of repeated identity-threading, and so every call goes
// through the typed repo layer (CLAUDE.md: no raw drizzle in apps).

import { Decimal, isPlainDecimalString } from '@app/money';
import { isTerminalOrderStatus, type ProfileId, type UserId } from '@app/contracts';
import type { AccountRepo, ProfileRepo } from '@app/db';
import type { NotifierRowInput } from 'notifiers/lookup.js';

/**
 * Row shape `persistOrder` writes to the `orders` table.
 */
export interface PersistedOrder {
  readonly userId: UserId;
  readonly profileId: ProfileId;
  readonly symbol: string;
  readonly side: 'BUY' | 'SELL';
  readonly intent: string;
  readonly binanceOrderId: bigint;
  readonly clientOrderId: string;
  readonly status: string;
  readonly raw: unknown;
  /**
   * Strategy-owned order metadata forwarded from
   * `Decision.place-order.intent.meta` (TT writes `{ gridTradeIndex }`).
   * Persists opaquely to the `orders.meta` jsonb column. Undefined for
   * orders carrying no metadata; the column accepts NULL.
   */
  readonly meta?: Record<string, unknown>;
}

/**
 * Binance order IDs are unsigned 64-bit integers and have already crossed
 * `Number.MAX_SAFE_INTEGER` on production accounts; a naive `BigInt(n)`
 * promotes a precision-lost number into a wrong-looking bigint, which
 * would then quietly miss the real row on lookup or update. The executor
 * contract types `decision.orderId: number`, so the safest place to fail
 * loudly is right here at the repo boundary: refuse anything that isn't
 * a non-negative safe integer.
 */
/**
 * The un-filled quantity an order is still holding on the exchange, read off the
 * `raw` exchange snapshot the row was written from. Null when the snapshot does
 * not carry readable quantities (an ACK-shape placement response) — the order is
 * holding SOMETHING, we just cannot say how much, and the caller must treat that
 * as unknown rather than as zero.
 */
const remainingQtyOf = (raw: unknown): string | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { origQty?: unknown; executedQty?: unknown };
  if (typeof r.origQty !== 'string' || !isPlainDecimalString(r.origQty)) return null;
  const executed =
    typeof r.executedQty === 'string' && isPlainDecimalString(r.executedQty) ? r.executedQty : '0';
  return new Decimal(r.origQty).minus(new Decimal(executed)).toString();
};

/**
 * The order's limit price, when the snapshot carries a usable one. A cancelled BUY
 * hands back QUOTE, and quote released = remaining quantity x price — so without the
 * price the release is real but unquantifiable. A MARKET order's `price` is '0',
 * which is not a price: null, not zero.
 */
const priceOf = (raw: unknown): string | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { price?: unknown };
  if (typeof r.price !== 'string' || !isPlainDecimalString(r.price)) return null;
  return new Decimal(r.price).gt(0) ? r.price : null;
};

const toRepoOrderId = (orderId: number): bigint => {
  if (!Number.isSafeInteger(orderId) || orderId < 0) {
    throw new Error(
      `profile-bindings: orderId must be a non-negative safe integer (got ${orderId})`,
    );
  }
  return BigInt(orderId);
};

/**
 * The four write/lookup callbacks `ProfileExecutorBindings` exposes as its
 * nested `persistence` group.
 */
export interface ProfilePersistence {
  /**
   * `closePrevious` is the caller's proof that the order currently holding this
   * `(symbol, intent)` live slot is gone from the exchange. When it is false the
   * previous order may still be RESTING, so closing its row would record a live
   * order as cancelled; the write throws instead.
   */
  readonly persistOrder: (
    row: PersistedOrder,
    options: { readonly closePrevious: boolean },
  ) => Promise<void>;
  /**
   * Record an order that IS live on Binance but whose normal bookkeeping did not
   * land. Best-effort and non-throwing at the callsite: it exists so a live order
   * still gets a durable row carrying its Binance id, instead of resting on the
   * exchange with no local trace at all.
   */
  readonly persistTrackingOrder: (row: PersistedOrder) => Promise<void>;
  /**
   * The live slot `(symbol, intent)` an order occupies, read from its local row,
   * plus what that order is still HOLDING on the exchange. Null when no row exists
   * (an order placed but never persisted).
   *
   * The cancel handler needs the intent, not just the symbol: a failed cancel must
   * mark the exact slot it left holding a live order. It needs `side` and
   * `remainingQty` for the other direction — a SUCCESSFUL cancel gives that
   * quantity back to the wallet, and the next decision in the same batch (the
   * replacement order, or the exit SELL) must be judged against the wallet as it
   * is once that release lands, not as the stale snapshot still shows it.
   * `remainingQty` (and, for a BUY, `price` — quote released is quantity x price) is
   * null when the row's `raw` does not carry it: a release of unknown size, which is
   * not the same as none.
   */
  readonly resolveOrderSlot: (orderId: number) => Promise<{
    readonly symbol: string;
    readonly intent: string;
    readonly side: string;
    readonly remainingQty: string | null;
    readonly price: string | null;
  } | null>;
  readonly closeOrder: (
    orderId: number,
    status: string,
    closedAtMs?: number,
    // Fresh exchange snapshot to overwrite the row's `raw` with; supplied by
    // the cancel-vs-fill reconciliation so `executedQty` is truthful.
    raw?: unknown,
  ) => Promise<void>;
  /**
   * Append an `action_logs` row recording that an order was accepted by
   * Binance but the post-submit bookkeeping (persist / Redis / emit) then
   * failed — the operator must reconcile by hand. Scoped to this profile.
   */
  readonly recordBookkeepingFailure: (entry: {
    symbol: string;
    orderId: number;
    err: string;
  }) => Promise<void>;
  /**
   * This profile's enabled notifier rows (config + secrets), for the
   * emergency-notify path to resolve and fan out to. An empty array means the
   * profile has no notifier, which drives the gap trace (the operator was not
   * alerted out-of-band on a real-money emergency).
   */
  readonly listEnabledNotifiers: () => Promise<readonly NotifierRowInput[]>;
  /**
   * Append a `warn`-level `action_logs` row recording that a real-money
   * emergency notify fired but this profile has no enabled notifier, so the
   * operator was not alerted out-of-band. Durable surface for the gap;
   * CLAUDE.md invariant: no silent failures.
   */
  readonly recordNotifierGap: (entry: { topic: string; symbol?: string }) => Promise<void>;
  /**
   * Cross-symbol KV writes. `setKv` upserts a strategy-owned
   * namespaced key into the per-profile store; `deleteKv` removes it
   * (idempotent). Scoped to this profile via the bound {@link ProfileRepo}.
   */
  readonly setKv: (key: string, value: unknown) => Promise<void>;
  readonly deleteKv: (key: string) => Promise<void>;
}

/**
 * The `orders` column set the repo accepts (account + profile come off the scope).
 * Derived from the bound repo rather than re-declared so a schema change surfaces
 * here as a type error instead of a silently-dropped column.
 */
type OrderValues = Parameters<ProfileRepo['orders']['insert']>[0];

/**
 * Optional injection seams. `clock` defaults to `Date.now()`; tests pin a
 * fixed instant for deterministic row values. `logger` lets the closure
 * surface a `closeOrder` zero-match so the executor (which currently
 * types `closeOrder` as `Promise<void>`) is not the only consumer of that
 * signal — without it, a stale Binance event silently does nothing.
 */
export interface PersistenceDeps {
  readonly clock?: { nowMs(): number };
  readonly logger?: { warn(obj: Readonly<Record<string, unknown>>, msg: string): void };
}

/**
 * Build the persistence bundle for a single profile. The `ProfileRepo`
 * is already scoped to one owned `(userId, profileId)` via the single
 * `scopeProfile` ownership check, so the closure does not re-check.
 */
export const buildPersistence = (
  p: ProfileRepo,
  // Order reconciliation by Binance id is ACCOUNT-domain (the id is unique per
  // account, the user-data stream is per account, and a detached order is
  // reachable only by account), so those reads/writes come off the account
  // surface even though everything else here is profile-scoped.
  a: AccountRepo,
  deps: PersistenceDeps = {},
): ProfilePersistence => {
  const clock = deps.clock ?? { nowMs: () => Date.now() };
  const { operatorId, profileId } = p.scope;

  // Column set + terminal-state verdict for one order row. ONE computation, shared
  // by every binding that writes an `orders` row, because `closed_at` is not a
  // formatting detail: a terminal row left open holds the partial unique live slot
  // (so the next order's `upsertLive` stamps this genuinely-FILLED row CANCELED and
  // erases a real trade from the archive), counts forever toward the account's open
  // exposure, and stays in the tracked-live set the orphan sweep diffs against.
  //
  // `closed_at` is sourced from the exchange, not the worker's wall-clock at insert,
  // and WHICH exchange field carries it depends on where `raw` came from: the REST
  // `newOrder` response has `transactTime`; a PROBED order (`GET /api/v3/order`, the
  // lost-response recovery path) does NOT — it carries `updateTime` / `time`. So try
  // them in that order. `Number.isFinite` rejects strings / null / NaN so a malformed
  // payload lands a valid clock fallback rather than an `Invalid Date`.
  const toRowValues = (row: PersistedOrder): { values: OrderValues; isClosed: boolean } => {
    // The shared terminal vocabulary, not a local list: a status terminal for
    // the open-orders cache but not here (`EXPIRED_IN_MATCH`, the self-trade-
    // prevention terminator) writes a `closed_at`-NULL row that occupies the
    // live slot and the account's open exposure forever.
    const isClosed = isTerminalOrderStatus(row.status);
    const raw = row.raw as
      { transactTime?: unknown; updateTime?: unknown; time?: unknown } | null | undefined;
    const epochMs = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    const exchangeTimeMs =
      epochMs(raw?.transactTime) ?? epochMs(raw?.updateTime) ?? epochMs(raw?.time);
    return {
      isClosed,
      values: {
        symbol: row.symbol,
        side: row.side,
        intent: row.intent,
        binanceOrderId: row.binanceOrderId,
        clientOrderId: row.clientOrderId,
        status: row.status,
        raw: row.raw,
        closedAt: isClosed ? new Date(exchangeTimeMs ?? clock.nowMs()) : null,
        // `meta` is nullable; null when the strategy attached no
        // order metadata (sell-side, manual, momentum entry/exit).
        meta: row.meta ?? null,
      },
    };
  };

  return {
    persistOrder: async (row, options) => {
      const { values, isClosed } = toRowValues(row);
      // A still-live row (LIMIT/stop resting on the exchange) contends for
      // the partial unique live slot `(profile_id, symbol, intent) WHERE
      // closed_at IS NULL`. Route it through `upsertLive`, which closes any
      // stale live row for the slot and inserts the replacement in one
      // transaction — so a re-priced grid order or a re-placed entry never
      // hits the unique violation. Terminal rows (FILLED MARKET, etc.) land
      // `closed_at` non-null and so never occupy the slot: keep them on the
      // plain `insert` so the instant-fill fast path stays byte-identical.
      if (isClosed) {
        await p.orders.insert(values);
      } else {
        await p.orders.upsertLive(values, options);
      }
    },
    persistTrackingOrder: async (row) => {
      // Same terminal computation as `persistOrder`. Both callers of this binding
      // can carry a terminal status — a probed MARKET order comes back FILLED, and
      // the bookkeeping-recovery path replays the exchange's own `dto.status` — so
      // hardcoding an open row here would write a FILLED order with `closed_at`
      // NULL. A still-resting order (NEW / PARTIALLY_FILLED) is left open, which is
      // what keeps it visible to the reconciliation paths.
      await p.orders.insertTracking(toRowValues(row).values);
    },
    resolveOrderSlot: async (orderId) => {
      const row = await a.orders.findByBinanceOrderId(toRepoOrderId(orderId));
      return row
        ? {
            symbol: row.symbol,
            intent: row.intent,
            side: row.side,
            remainingQty: remainingQtyOf(row.raw),
            price: priceOf(row.raw),
          }
        : null;
    },
    closeOrder: async (orderId, status, closedAtMs, raw) => {
      const closed = await a.orders.closeByBinanceOrderId(
        toRepoOrderId(orderId),
        status,
        closedAtMs,
        raw,
      );
      if (closed === 0) {
        deps.logger?.warn(
          { operatorId, profileId, binanceOrderId: orderId, status },
          'closeOrder matched zero live rows',
        );
      }
    },
    recordBookkeepingFailure: async (entry) => {
      await p.actionLogs.append({
        time: new Date(clock.nowMs()),
        symbol: entry.symbol,
        level: 'error',
        msg: 'order accepted but post-submit bookkeeping failed',
        ctx: { orderId: entry.orderId, err: entry.err },
      });
    },
    listEnabledNotifiers: async () => {
      const rows = await p.profileNotifiers.listForProfile();
      return rows.filter((n) => n.enabled);
    },
    recordNotifierGap: async (entry) => {
      await p.actionLogs.append({
        time: new Date(clock.nowMs()),
        // `action_logs.symbol` is nullable; null when the emergency carries
        // no symbol context.
        symbol: entry.symbol ?? null,
        level: 'warn',
        msg: `real-money ${entry.topic} fired but this profile has no enabled notifier — you were not alerted`,
        ctx: { topic: entry.topic },
      });
    },
    setKv: async (key, value) => {
      await p.profileKv.upsert(key, value);
    },
    deleteKv: async (key) => {
      await p.profileKv.remove(key);
    },
  };
};
