// EventRouter: translates WS events into BullMQ tick enqueues.
//
//   miniTicker(symbol)   → for each profileId in profilesUsing(symbol):
//                            tickQueue.add(jobId: tick:<profileId>:<symbol>)
//   kline(symbol,intvl)  → if isClosed: IndicatorComputer.recompute(symbol, interval)
//                          then enqueue tick(event='kline-close') to subscribers
//   user event(profile)  → enqueue tick on the affected symbol(s) for that profile only
//
// In-process O(1) dispatch; no Redis SUBSCRIBE indirection.

import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  isTerminalOrderStatus,
  unwrapId,
  type AccountId,
  type ProfileId,
  type UserId,
} from '@app/contracts';
import { GLOBAL_KEYS } from '@app/db';
import type { TickEvent, TickJobData } from 'queues/job-payloads.js';
import { tickJobId } from 'queues/queue-names.js';
import { buildOpenOrdersKey, buildUserStreamEventKey } from 'executor/redis-namespace.js';
import { patchOpenOrder, removeOpenOrder } from 'executor/open-orders-cache.js';
import {
  createOrderCommissionAccumulator,
  orderCommissionKey,
} from 'executor/order-commission-accumulator.js';
import type { FillAdopter } from 'executor/fill-adopter.js';
import type { ProfileManager } from 'profile-manager/profile-manager.js';
import type { ParsedMarketEvent } from 'market-data/types.js';
import type { UserStreamEvent } from 'user-stream/user-stream-pool.js';

// A symbol that stopped streaming for this long reads as absent rather than
// reporting a stale price as if it were current.
const TICKER_TTL_S = 60;

/** Who owns the order an execution report refers to, from this profile's view. */
export type OrderOwnership = 'own' | 'sibling' | 'detached';

export interface IndicatorComputerHook {
  recompute(symbol: string, interval: string, candle: ClosedCandle): Promise<void>;
}

export interface ClosedCandle {
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string;
}

export interface EventRouterDeps {
  readonly tickQueue: Queue<TickJobData>;
  readonly redis: Redis;
  readonly profileManager: ProfileManager;
  readonly indicatorComputer: IndicatorComputerHook;
  /**
   * Fill-adopter — mutates TT state (LBP + held qty) on every FILLED
   * executionReport. Runs BEFORE the subsequent tick enqueue so the
   * tick reads the post-fill state.
   */
  readonly fillAdopter: FillAdopter;
  /**
   * Backfills fills missed during a user-stream disconnect. Called per
   * symbol on `onProfileResync` (user-stream reconnect) BEFORE the resync
   * tick so the tick reads the recovered cost basis.
   */
  readonly backfillFills: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    symbol: string,
  ) => Promise<void>;
  /**
   * Merges the changed balances from an `outboundAccountPosition` WS frame
   * into the `account-info` Redis snapshot (the source of truth for wallet
   * balances on the tick path and dashboard) so a fill is reflected within one
   * round-trip instead of waiting on the 5s safety cron. MERGE, not overwrite:
   * the frame's `B` array is only the assets the trade changed, not the full
   * account, so overwriting blanks every unchanged asset the bot still holds.
   */
  readonly mergeAccount: (
    accountId: AccountId,
    profileId: ProfileId,
    changed: readonly { asset: string; free: string; locked: string }[],
  ) => Promise<void>;
  /**
   * Cross-profile isolation gate for execution reports. A single account is
   * shared by N profiles, but Binance issues ONE user-data stream per account,
   * so every profile's stream receives the WHOLE account's execution reports —
   * including orders a sibling placed and orders no profile owns any more.
   *
   * Resolves who, if anyone, owns `binanceOrderId`:
   *
   *   - `own`      — this profile's order (or nobody's YET: its own just-placed
   *                  order whose row has not committed). Adopt it.
   *   - `sibling`  — positively owned by a DIFFERENT profile on this account.
   *                  Drop: that profile gets the same report on its own stream.
   *   - `detached` — the row exists but its profile was deleted (`profile_id`
   *                  NULL). Nobody can adopt it, but the ledger row must still
   *                  be closed, so it routes to `reconcileDetachedFill`.
   *
   * Required, not optional: the only safe default is refusing to guess. An
   * absent gate would have to assume `own`, which adopts every sibling's fill
   * into this profile's position — the exact corruption the gate exists to
   * prevent, and invisible at runtime.
   */
  readonly classifyOrder: (
    operatorId: UserId,
    accountId: AccountId,
    profileId: ProfileId,
    binanceOrderId: number,
  ) => Promise<OrderOwnership>;
  readonly logger: Logger;
  readonly clock?: { nowMs(): number };
}

export interface EventRouter {
  onMarketEvent(event: ParsedMarketEvent): Promise<void>;
  onUserEvent(event: UserStreamEvent): Promise<void>;
  onResync(symbol: string): Promise<void>;
  onProfileResync(userId: UserId, profileId: ProfileId): Promise<void>;
}

export const createEventRouter = (deps: EventRouterDeps): EventRouter => {
  const clock = deps.clock ?? { nowMs: () => Date.now() };
  // Binance reports commission per TRADE while qty/quote are cumulative, and
  // the adopter only acts on the terminal report — so the order's total fee has
  // to be summed here, where every partial is seen. Scoped to the router
  // instance (one per worker) rather than the module, so tests get isolation.
  const commissions = createOrderCommissionAccumulator(clock);

  const enqueue = async (
    profileId: ProfileId,
    symbol: string,
    event: TickEvent,
    payload: Record<string, unknown>,
  ): Promise<void> => {
    const operatorId = deps.profileManager.operatorOf(profileId);
    const accountId = deps.profileManager.accountOf(profileId);
    if (!operatorId || !accountId) return;
    await deps.tickQueue.add(
      'tick',
      {
        userId: unwrapId(operatorId),
        accountId: unwrapId(accountId),
        profileId: unwrapId(profileId),
        symbol,
        event,
        enqueuedAtMs: clock.nowMs(),
        payload,
      },
      {
        jobId: tickJobId(unwrapId(profileId), symbol),
        // Tick jobs use a static jobId (`tick:<pid>:<sym>`) for in-flight
        // coalescing: while one tick is waiting or running, additional
        // WS events for the same (profile, symbol) collapse into it.
        // BullMQ rejects an `.add()` whose jobId already exists in ANY
        // state, including the retained `completed` / `failed` ZSETs —
        // so `removeOnComplete: true` / `removeOnFail: true` is required
        // to clear the slot at terminal state. With a count- or age-based
        // retention every (pid, sym) silently stops re-enqueueing once
        // its first tick lands in completed.
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  };

  return {
    async onMarketEvent(event) {
      if (event.kind === 'mini-ticker') {
        const subscribers = deps.profileManager.profilesUsing(event.symbol);
        await Promise.all([
          // Symbol-global current price for the dashboard: one write per
          // symbol, not one per subscribing profile.
          deps.redis.set(
            GLOBAL_KEYS.ticker(event.symbol),
            JSON.stringify({ price: event.closePrice, ts: clock.nowMs() }),
            'EX',
            TICKER_TTL_S,
          ),
          ...subscribers.map((pid) =>
            enqueue(pid, event.symbol, 'mini-ticker', { closePrice: event.closePrice }),
          ),
        ]);
        return;
      }
      // kline
      if (!event.isClosed) return;
      const candle: ClosedCandle = {
        openTimeMs: event.openTimeMs,
        closeTimeMs: event.closeTimeMs,
        open: event.open,
        high: event.high,
        low: event.low,
        close: event.close,
        volume: event.volume,
      };
      try {
        await deps.indicatorComputer.recompute(event.symbol, event.interval, candle);
      } catch (err) {
        deps.logger.error(
          { symbol: event.symbol, interval: event.interval, err: err },
          'indicator recompute failed; tick will use stale indicators',
        );
      }
      const subscribers = deps.profileManager.profilesUsing(event.symbol);
      await Promise.all(
        subscribers.map((pid) =>
          enqueue(pid, event.symbol, 'kline-close', { interval: event.interval, candle }),
        ),
      );
    },
    async onUserEvent(event) {
      // Resolve the account (tenant, keys every Redis namespace) and operator
      // for this event's profile from the in-memory membership set. The
      // user-stream envelope carries only (userId, profileId); the per-account
      // identity the Redis keys and repo scopes need is derived here so the
      // pool stays account-agnostic. A profile that left the active set between
      // the WS frame and here has nothing to route.
      const accountId = deps.profileManager.accountOf(event.profileId);
      const operatorId = deps.profileManager.operatorOf(event.profileId);
      if (!accountId || !operatorId) return;
      // Stamp the WS-liveness marker. Any user-stream event proves the
      // socket is delivering; `account-snapshot-safety` reads this to
      // skip its REST refresh while the stream is healthy. The marker
      // expires after an hour so a disabled profile's key does not linger.
      // Best-effort: the marker is non-critical observability metadata —
      // a failed write must not block the critical tick-enqueue routing
      // below (the cron simply falls back to a REST refresh).
      try {
        await deps.redis.set(
          buildUserStreamEventKey(accountId, event.profileId),
          String(clock.nowMs()),
          'EX',
          3_600,
        );
      } catch (err) {
        deps.logger.warn(
          { profileId: event.profileId, err: err },
          'event-router: failed to stamp user-stream liveness marker; continuing routing',
        );
      }
      if (event.kind === 'execution-report') {
        // Cross-profile isolation gate. With one account shared by N profiles,
        // Binance issues a single user-data stream per account, so this report
        // may be for an order a SIBLING profile placed (its symbol may not even
        // be in this profile's set). Adopting it would write a position this
        // profile does not own and tick a foreign symbol; drop it. The profile
        // that placed the order receives the same report on its own stream and
        // processes it there. The gate drops ONLY a positively foreign order, so
        // this profile's own just-placed order — whose row may not have committed
        // yet — is still processed, keeping fill adoption independent of the
        // orders-row write racing the WS frame.
        const ownership = await deps.classifyOrder(
          operatorId,
          accountId,
          event.profileId,
          event.orderId,
        );
        if (ownership === 'sibling') return;
        if (ownership === 'detached') {
          // The order's profile was deleted, so no position can absorb the fill —
          // but the exchange says the order is done, and a live row nobody closes
          // is permanent phantom exposure that blocks the account's own deletion.
          // Close the ledger row and stop: no adoption, and no tick for a profile
          // that does not own the symbol. Every active profile on the account gets
          // this same report; the close is idempotent, so the fan-out settles once.
          try {
            await deps.fillAdopter.reconcileDetachedFill({
              operatorId,
              accountId,
              symbol: event.symbol,
              orderId: event.orderId,
              orderStatus: event.orderStatus,
              cumQty: event.cumQty,
              cumQuoteQty: event.cumQuoteQty,
              // The exchange's own event time, not ours: it is what stamps
              // `closed_at`, and the cron that settles the SAME rows off
              // `getOrder` passes Binance's `updateTime`. Sourcing one from the
              // wall clock would give a row a different `closed_at` depending on
              // which path happened to settle it. The frame parser defaults a
              // missing `E` to 0, so the clock stays the fallback.
              eventTimeMs: event.eventTimeMs || clock.nowMs(),
            });
          } catch (err) {
            deps.logger.error(
              {
                accountId,
                symbol: event.symbol,
                orderId: event.orderId,
                err: err,
              },
              'event-router: detached-order reconcile threw; the row stays open until the reconcile cron retries',
            );
          }
          return;
        }
        // Mutate the shared open-orders snapshot in place FIRST so any tick that
        // observes the post-adopt strategy state also observes the fresh order
        // list. Reversing the order opens a window where a concurrent tick on a
        // sibling chain (e.g. market-data kline-close) could read mutated state +
        // stale orders. A terminal report removes the order, a partial fill
        // patches its filled amounts; both are no-ops on an absent key (it
        // cold-loads once next tick) so a dropped WS signal self-heals via the
        // key TTL rather than a fabricated entry.
        // Fold this report's per-trade commission into the order's running
        // total BEFORE the terminal read below, so a single-trade order (whose
        // only TRADE report IS the terminal one) is counted too. The key is
        // account-scoped and the read is non-destructive because every profile
        // on this account is routed this same report: each of them must be able
        // to hand the whole fee to the adopter.
        const feeKey = orderCommissionKey(unwrapId(accountId), event.symbol, event.orderId);
        commissions.record(feeKey, {
          executionType: event.executionType,
          tradeId: event.tradeId,
          commission: event.commission,
          commissionAsset: event.commissionAsset,
        });
        const orderCommission = isTerminalOrderStatus(event.orderStatus)
          ? commissions.take(feeKey)
          : null;
        try {
          const key = buildOpenOrdersKey(accountId, event.symbol);
          // `isTerminalOrderStatus` is the shared vocabulary from `@app/contracts`,
          // not a local set: the cache eviction here, the boot reaper's close and
          // the `orders` row's `closed_at` stamp must agree on which statuses are
          // done, or a status terminal for one of them (`EXPIRED_IN_MATCH`, the
          // self-trade-prevention terminator) leaves the ledger claiming the order
          // still rests while the cache says it is gone.
          if (isTerminalOrderStatus(event.orderStatus)) {
            await removeOpenOrder(deps.redis, key, event.orderId);
          } else if (event.orderStatus === 'PARTIALLY_FILLED') {
            await patchOpenOrder(deps.redis, key, event.orderId, {
              executedQty: event.cumQty,
              cumQuote: event.cumQuoteQty,
              status: event.orderStatus,
            });
          }
        } catch (err) {
          deps.logger.warn(
            { profileId: event.profileId, symbol: event.symbol, err: err },
            'event-router: failed to patch open-orders cache on execution-report; next tick reads stale snapshot',
          );
        }
        // Adopt the fill into TT state BEFORE enqueueing the tick so
        // the strategy sees the post-fill position. A failure here
        // must not block the tick — the operator will still benefit
        // from the tick running against pre-fill state; the next
        // executionReport (or a manual re-tick) re-attempts adoption.
        try {
          await deps.fillAdopter.adopt({
            operatorId,
            accountId,
            profileId: event.profileId,
            symbol: event.symbol,
            orderId: event.orderId,
            tradeId: event.tradeId,
            orderStatus: event.orderStatus,
            side: event.side,
            cumQty: event.cumQty,
            cumQuoteQty: event.cumQuoteQty,
            ...(orderCommission ?? {}),
          });
        } catch (err) {
          deps.logger.error(
            {
              profileId: event.profileId,
              symbol: event.symbol,
              orderId: event.orderId,
              err: err,
            },
            'event-router: fill-adopter threw; tick will read pre-fill state',
          );
        }
        await enqueue(event.profileId, event.symbol, 'execution-report', {
          orderId: event.orderId,
          orderStatus: event.orderStatus,
          executionType: event.executionType,
        });
        return;
      }
      if (event.kind === 'balance-update' || event.kind === 'account-position') {
        // `outboundAccountPosition` carries only the assets the triggering
        // trade changed (a delta), NOT the full account — so MERGE it into the
        // account-info cache rather than overwriting, which would blank every
        // unchanged asset the bot still holds. `balanceUpdate` carries a bare
        // delta with no usable balance figures, so only `account-position`
        // patches the cache. The merge keeps the snapshot whole between the
        // safety cron's full refreshes (which the cron skips while WS is live).
        if (event.kind === 'account-position') {
          try {
            await deps.mergeAccount(accountId, event.profileId, event.balances);
          } catch (err) {
            deps.logger.warn(
              { profileId: event.profileId, err: err },
              'event-router: mergeAccount on account-position failed; cron will catch up on next refresh',
            );
          }
        }
        // Balance / account-position events affect every symbol the profile owns.
        const symbols = deps.profileManager.symbolsFor(event.profileId);
        await Promise.all(symbols.map((s) => enqueue(event.profileId, s, 'balance-update', {})));
      }
    },
    async onResync(symbol) {
      const subscribers = deps.profileManager.profilesUsing(symbol);
      await Promise.all(
        subscribers.map((pid) => enqueue(pid, symbol, 'resync', { reason: 'market-reconnect' })),
      );
    },
    async onProfileResync(_userId, profileId) {
      // The user-stream pool passes its (userId, profileId) envelope; the
      // per-account identity the backfill's Binance/repo calls need is derived
      // from the in-memory membership set instead. A profile no longer active
      // has nothing to resync.
      const operatorId = deps.profileManager.operatorOf(profileId);
      const accountId = deps.profileManager.accountOf(profileId);
      if (!operatorId || !accountId) return;
      const symbols = deps.profileManager.symbolsFor(profileId);
      await Promise.all(
        symbols.map(async (s) => {
          // The stream was down, so the shared open-orders snapshot may have
          // missed a place/cancel/fill. DEL it so the resync tick cold-loads
          // exactly one bounded REST snapshot, after which WS-merge resumes.
          // Best-effort: a failed invalidation only means the TTL is the
          // backstop, so it must not block the backfill/resync below.
          try {
            await deps.redis.del(buildOpenOrdersKey(accountId, s));
          } catch (err) {
            deps.logger.warn(
              { profileId, symbol: s, err: err },
              'event-router: failed to invalidate open-orders cache on user-stream reconnect; TTL is the backstop',
            );
          }
          // Backfill fills missed during the disconnect BEFORE the resync
          // tick so the tick reads the recovered cost basis. A backfill
          // failure must not block the resync tick — the tick still runs
          // against pre-backfill state and the next reconnect retries.
          try {
            await deps.backfillFills(operatorId, accountId, profileId, s);
          } catch (err) {
            deps.logger.error(
              { profileId, symbol: s, err: err },
              'event-router: fill backfill threw on user-stream reconnect; resync tick reads pre-backfill state',
            );
          }
          await enqueue(profileId, s, 'resync', { reason: 'user-stream-reconnect' });
        }),
      );
    },
  };
};
