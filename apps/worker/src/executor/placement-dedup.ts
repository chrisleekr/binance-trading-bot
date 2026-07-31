// Duplicate-MARKET-placement guard.
//
// A MARKET order fills and closes instantly, freeing its deterministic
// clientOrderId. Binance dedups only OPEN orders, so a re-emitted identical
// MARKET order is accepted and fills AGAIN. That is how a single logical entry
// became several live fills when a tick re-derived it (read-your-writes lost on
// a degraded state commit; see version-aware-mutate `commitSymbolStateForTick`).
//
// This backstops that state-layer fix: if its own cache refresh fails (Redis
// `set` throws during a degrade), the strategy could still re-emit a just-filled
// entry. Record-on-accept, then suppress a same-clientOrderId MARKET placement
// within the window.
//
// DURABLE ACROSS PROCESS DEATH. An in-process Map is the fast first line, but it
// is empty on a fresh process. On a SIGTERM drain that outruns its deadline, the
// pod is killed with a tick still mid-flight; BullMQ retries that tick on the
// NEXT pod, whose Map has never seen the just-placed clientOrderId — so the retry
// would re-place the MARKET order and fill it twice. A write-through/read-through
// Redis mirror (`placement-dedup:<symbolKey>` per-symbol SET, `record` SADD+PEXPIRE
// in one atomic MULTI/EXEC, `seenRecently` SISMEMBER on a Map miss) carries the
// record across processes and pods, so the retry on a fresh process sees the prior
// placement. The Map still short-circuits the common case with zero I/O. This closes
// the cross-process seam this module previously left to the state-layer fix alone.
//
// COARSER WINDOW THAN THE MAP, on purpose. The Redis SET is a key-level window: a
// `record` re-stamps the whole key's PEXPIRE on every write, and SISMEMBER returns 1
// for any member still present regardless of that member's own age. So on a fresh
// process an old clientOrderId can read as "seen" past its own 60s window when other
// levels keep re-stamping the key. That is the SAFE direction (over-suppress = no
// double-fill, never an extra one), and `forgetSymbol` DELs the key on every bot
// SELL, so a legitimate re-entry is not held back by it.
//
// Every Redis touch is deadline-bounded and FAIL-OPEN on the read (`seenRecently`
// returns false when SISMEMBER stalls or rejects, so a Redis fault can never halt
// a placement) and NEVER-THROW on the write (`record`/`forgetSymbol` swallow, so a
// mirror failure can never fail a tick). `record` is awaited by callers so the
// mirror is durable BEFORE the tick's own state commit.
//
// EPOCH DISCRIMINATION via `forgetSymbol`. A trailing-trade entry clientOrderId
// is STABLE per (profile, symbol[, level]) — it folds no candle or epoch (see
// `firstBuyClientOrderId` / `gridBuyClientOrderId`), so a LEGITIMATE re-entry
// after a close reuses the exact same id. A profitable exit carries no re-entry
// cooldown, so that re-entry can land inside the window. Time alone therefore
// cannot tell a duplicate re-emit from a genuine re-entry. The discriminator is
// the exit: the executor calls `forgetSymbol` on EVERY bot SELL it places — a
// full exit, a partial grid/rebalance sell, OR a protective-stop arm — dropping
// that symbol's entry records (Map group + Redis SET), so a re-entry after any of
// those is never suppressed. Clearing on a stop-arm or partial (not only a full
// close) disarms the backstop earlier, but that is safe: the degraded-commit tick
// that would re-emit an entry believes it holds NO position, so it emits no SELL
// that same tick — forget and entry-re-emit are effectively mutually exclusive for
// one position. (Residual tail: a re-entry within the window after an OUT-OF-BAND
// close — operator manually selling on Binance, no bot SELL — is not cleared; the
// window bounds it, and the state-layer fix is the primary guard.)
//
// SELL SIDE is intentionally NOT deduped here: a SELL always forgets and places,
// its own re-emit is never `seenRecently`-checked. The state-layer read-your-
// writes fix is the primary guard for sells too, and a duplicate FULL-exit sell
// self-bounds (the second hits Binance -2010, nothing left to sell). A duplicate
// PARTIAL MARKET sell (rebalance / force-sell) could over-sell in the same rare
// compound failure the buy side guards; symmetric sell coverage is a possible
// follow-up, left out here to avoid a sell-side re-suppression regression.
//
// Scoped to MARKET on purpose: a resting stop-limit stays OPEN, so Binance's own
// dedup covers it AND grid trail-down repricing legitimately cancels+re-places
// the SAME clientOrderId — deduping those would break the grid.
//
// The Redis SET is a self-expiring idempotency mirror keyed per symbol, not a
// lock (no owner, no release/refund). The SADD and PEXPIRE are one atomic
// MULTI/EXEC, so the SET can never exist without a TTL — it always self-expires.
// Like the request-weight bucket and the notifier-gap throttle, it is coordination
// infrastructure the no-locks gate permits.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { raceDeadline } from 'lib/race-deadline.js';

/** Window in which a repeated MARKET clientOrderId is treated as a duplicate. */
export const PLACEMENT_DEDUP_WINDOW_MS = 60_000;

// Deadline for each Redis touch. The executor's ioredis runs with
// `maxRetriesPerRequest: null` and no command timeout, so a reachable-but-stalled
// Redis would hang a call the tick path awaits. The race abandons instead — the
// read fails open, the write is best-effort. Mirrors the notifier-gap throttle.
export const PLACEMENT_DEDUP_REDIS_TIMEOUT_MS = 500;

/** Per-symbol Redis SET key. Not a lock — a self-expiring idempotency mirror. */
const KEY_PREFIX = 'placement-dedup:';

export interface PlacementDedup {
  /**
   * True if this clientOrderId was recorded within the window (a duplicate). A
   * Map hit resolves with zero I/O; a Map miss consults the durable Redis mirror
   * (fail-open: a stalled or failed lookup resolves false so placement proceeds).
   */
  readonly seenRecently: (
    clientOrderId: string,
    symbolKey: string,
    nowMs: number,
  ) => Promise<boolean>;
  /**
   * Record a placed MARKET clientOrderId under its symbol group — in the Map and,
   * durably, in the per-symbol Redis SET. Awaited by callers so the mirror lands
   * before the tick's state commit. Prunes expired Map keys so it stays bounded.
   * Never throws: a mirror failure is swallowed, the Map record still holds.
   */
  readonly record: (clientOrderId: string, symbolKey: string, nowMs: number) => Promise<void>;
  /**
   * Drop every record for a symbol group — called when a SELL (an exit) is placed
   * for that symbol, so a legitimate re-entry after the close is not suppressed.
   * Clears both the Map group and the durable Redis SET. Never throws.
   */
  readonly forgetSymbol: (symbolKey: string, nowMs: number) => Promise<void>;
}

interface Recorded {
  readonly at: number;
  readonly symbolKey: string;
}

export interface PlacementDedupDeps {
  /** Durable mirror. Omitted ⇒ Map-only (single-process, no cross-pod dedup). */
  readonly redis?: Redis;
  readonly logger?: Logger;
  readonly setTimeoutMs?: number;
}

export const createPlacementDedup = (
  windowMs: number = PLACEMENT_DEDUP_WINDOW_MS,
  deps: PlacementDedupDeps = {},
): PlacementDedup => {
  const seen = new Map<string, Recorded>();
  const { redis, logger } = deps;
  const setTimeoutMs = deps.setTimeoutMs ?? PLACEMENT_DEDUP_REDIS_TIMEOUT_MS;
  const keyFor = (symbolKey: string): string => `${KEY_PREFIX}${symbolKey}`;

  const prune = (nowMs: number): void => {
    for (const [k, v] of seen) if (nowMs - v.at >= windowMs) seen.delete(k);
  };

  return {
    seenRecently: async (clientOrderId, symbolKey, nowMs) => {
      const rec = seen.get(clientOrderId);
      // Map hit short-circuits with zero I/O — the common single-process case.
      if (rec !== undefined && nowMs - rec.at < windowMs) return true;
      if (!redis) return false;
      // Map miss: a fresh process (BullMQ retry after a pod died mid-tick) has an
      // empty Map but the durable mirror still holds the prior placement.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('placement-dedup: SISMEMBER timed out')),
            setTimeoutMs,
          );
        });
        const res = await Promise.race([
          redis.sismember(keyFor(symbolKey), clientOrderId),
          deadline,
        ]);
        return res === 1;
      } catch (err: unknown) {
        // Fail open: a Redis fault must never halt a placement (that would strand a
        // legitimate order). The state-layer read-your-writes fix stays the primary
        // guard; a duplicate here is the rare, already-bounded compound failure.
        logger?.warn(
          { clientOrderId, symbolKey, err: err },
          'placement-dedup: redis lookup failed, allowing the placement through',
        );
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    record: async (clientOrderId, symbolKey, nowMs) => {
      prune(nowMs);
      seen.set(clientOrderId, { at: nowMs, symbolKey });
      if (!redis) return;
      const key = keyFor(symbolKey);
      // Best-effort durable mirror. raceDeadline resolves (never rejects), so a
      // stalled or failed write cannot fail the tick — the Map record still holds
      // for same-process dedup. One atomic MULTI/EXEC round-trip so the SET can
      // never exist without a TTL: were SADD and PEXPIRE separate commands, a write
      // abandoned at the deadline after SADD but before PEXPIRE would leave the SET
      // with no expiry, and it would never self-heal. PEXPIRE re-stamps the whole
      // SET's TTL each record. exec() results are not inspected — atomicity is the
      // guarantee we need, not per-command success.
      await raceDeadline(
        () => redis.multi().sadd(key, clientOrderId).pexpire(key, windowMs).exec(),
        setTimeoutMs,
        () =>
          logger?.warn(
            { clientOrderId, symbolKey },
            'placement-dedup: redis mirror write timed out; same-process dedup still holds',
          ),
        (err: unknown) =>
          logger?.warn(
            { clientOrderId, symbolKey, err: err },
            'placement-dedup: redis mirror write failed; same-process dedup still holds',
          ),
      );
    },

    forgetSymbol: async (symbolKey, nowMs) => {
      for (const [k, v] of seen) if (v.symbolKey === symbolKey) seen.delete(k);
      prune(nowMs);
      if (!redis) return;
      await raceDeadline(
        () => redis.del(keyFor(symbolKey)),
        setTimeoutMs,
        () =>
          logger?.warn(
            { symbolKey },
            'placement-dedup: redis forget timed out; the SET will expire on its own TTL',
          ),
        (err: unknown) =>
          logger?.warn(
            { symbolKey, err: err },
            'placement-dedup: redis forget failed; the SET will expire on its own TTL',
          ),
      );
    },
  };
};
