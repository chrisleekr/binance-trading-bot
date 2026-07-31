// orphan-orders-detect cron.
//
// Surfaces orders that are OPEN on the Binance master account but tracked by
// no local `orders` row, so the operator can adopt them into a profile (or
// cancel them on Binance). This is the inverse of the boot-time
// `reap-stale-orders` reconciler (which closes local-live rows absent from
// the exchange).
//
// Detection is account-wide WITHIN a Binance environment, not per-(profile,
// symbol): two profiles can share a symbol (profile_symbols PK is (profile_id,
// symbol)), and an orphan can sit on a symbol no profile subscribes to any
// more. So one account-scoped `getOpenOrders()` (no symbol) is diffed against
// every profile's live `binanceOrderId`s.
//
// And "the account" is literally the account: each first-class account holds its
// own Binance key pair and its own order book, so the handler resolves one client
// per DISTINCT ACCOUNT and scans each separately. Scanning per mode instead would
// silently cover only the first account found in each environment and leave every
// other account's untracked orders — real money — invisible. Orphans carry their
// accountId and mode so the adopt path only offers same-account profiles.
//
// The diff is a point-in-time snapshot, so it can race the bot's own STOP-order
// reprice churn (cancel old entry + place new every cycle): a just-canceled
// order can momentarily linger in the `getOpenOrders()` read after the DB has
// closed its row, producing a transient false orphan. The PUSH alert is
// therefore gated behind a two-tick confirmation (`confirmPersisted`) — only an
// orphan seen on two consecutive ticks alerts. The adopt-UI snapshot keeps the
// raw single-tick diff (it self-clears next tick and adopting a stale order
// fails gracefully); only the notification waits for confirmation.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import type { AccountId, OrphanOrder, OrphanSnapshot, UserId } from '@app/contracts';
import type { BinanceRestClient, OpenOrderDto } from '@app/binance';
import { GLOBAL_KEYS, ORPHAN_SNAPSHOT_TTL_S, profileRepo, repo } from '@app/db';
import type {
  AccountNotifyEventBatch,
  AccountNotifyOutcome,
} from 'notifiers/account-notify-event.js';
import type { BootContext } from 'boot/boot-context.js';
import type { ActiveProfile } from 'profile-manager/profile-manager.js';
import { defineCron, type CronDef } from './define.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';

/**
 * The exchange's open orders minus those a local live row already tracks.
 * Pure so the diff is unit-tested without REST or DB. `BigInt(orderId)`
 * matches the `reap-stale-orders` convention; an orphan whose id exceeds
 * 2^53 is still correctly flagged (every tracked id is a safe integer, so a
 * lossy large id can never collide with the tracked set).
 */
export const selectOrphans = (
  openOrders: readonly OpenOrderDto[],
  trackedLiveIds: ReadonlySet<bigint>,
): readonly OpenOrderDto[] => openOrders.filter((o) => !trackedLiveIds.has(BigInt(o.orderId)));

// The Binance environment an order lives on. Carried on every orphan so the adopt
// UI can refuse a cross-environment adoption, but it is NOT the scan key — the
// account is.
type BinanceMode = OrphanOrder['mode'];

/**
 * Project a Binance `OpenOrderDto` to the shared snapshot shape, tagged with the
 * account whose key pair found it and the environment that account trades on.
 * `orderId` becomes a string so a value above 2^53 survives JSON without
 * rounding (it is parsed back to bigint only at the DB boundary, on adopt).
 */
export const toOrphanOrder = (
  o: OpenOrderDto,
  mode: BinanceMode,
  accountId: AccountId,
): OrphanOrder => ({
  orderId: String(o.orderId),
  accountId,
  symbol: o.symbol,
  side: o.side,
  type: o.type,
  price: o.price,
  origQty: o.origQty,
  status: o.status,
  clientOrderId: o.clientOrderId,
  timeMs: o.time,
  mode,
});

// Candidates seen on the PREVIOUS tick, for the two-tick confirmation gate
// (see `confirmPersisted`). TTL outlives a couple of cron periods so a normal
// run refreshes it, but expires if the worker dies — a restart then re-confirms
// from scratch rather than trusting a stale prior-tick set.
const SEEN_TTL_S = 1_500; // 25 min ≈ 2.5 cron periods

/**
 * Redis-backed alert dedup: alert each orphan once, not every tick. Members are
 * bare order ids and every operation is scoped to ONE account, mirroring the
 * snapshot.
 *
 * Per account because both sets are REWRITTEN from what the caller passes, and the
 * caller only ever holds the orphans of the accounts it SUCCESSFULLY SCANNED this
 * tick — an account whose `getOpenOrders` failed is skipped, not aborted on. A
 * shared set would read that account's absence as "no longer orphaned" and prune
 * it: its alerted ids drop (so it re-alerts on recovery, a duplicate) and its seen
 * ids drop (so its two-tick confirmation restarts, delaying a genuine orphan).
 *
 * `computeNew` is read-only on the new-id question and only PRUNES ids no longer
 * orphaned (so an adopted or cancelled order drops out and a later recurrence
 * re-alerts). It deliberately does NOT mark new ids as alerted — the handler
 * commits only the ids it actually delivered (`commitAlerted`), so a failed send
 * retries next tick instead of being silently swallowed.
 */
export const createOrphanAlertStore = (redis: Redis) => ({
  /**
   * Two-tick confirmation. Returns the subset of `currentIds` that were ALSO
   * candidates on the previous tick for this account, and rewrites that account's
   * seen set to `currentIds`.
   *
   * The detector diffs a point-in-time Binance `getOpenOrders()` snapshot
   * against the DB's tracked-live set. The bot's own STOP-order reprice churn
   * (cancel the old entry + place a new one every cycle) can momentarily leave
   * a just-canceled order in the openOrders read while the DB has already
   * closed it — a transient false orphan. Such a transient is gone by the next
   * 10-min tick, so requiring two consecutive sightings filters it, while a
   * genuine orphan (which sits open indefinitely) survives. The alert is one
   * tick (~10 min) later as a result, which is fine: an orphan is not
   * time-critical.
   */
  confirmPersisted: async (
    accountId: AccountId,
    currentIds: readonly string[],
  ): Promise<string[]> => {
    const key = GLOBAL_KEYS.orphanSeen(accountId);
    const prev = new Set(await redis.smembers(key));
    const confirmed = currentIds.filter((id) => prev.has(id));
    await redis.del(key);
    if (currentIds.length) {
      await redis.sadd(key, ...currentIds);
      await redis.expire(key, SEEN_TTL_S);
    }
    return confirmed;
  },
  computeNew: async (accountId: AccountId, currentIds: readonly string[]): Promise<string[]> => {
    const key = GLOBAL_KEYS.orphanAlerted(accountId);
    const alerted = new Set(await redis.smembers(key));
    const current = new Set(currentIds);
    const gone = [...alerted].filter((id) => !current.has(id));
    if (gone.length) await redis.srem(key, ...gone);
    return currentIds.filter((id) => !alerted.has(id));
  },
  commitAlerted: async (accountId: AccountId, ids: readonly string[]): Promise<void> => {
    if (ids.length) await redis.sadd(GLOBAL_KEYS.orphanAlerted(accountId), ...ids);
  },
});

export interface OrphanOrdersDetectDeps {
  readonly logger: Logger;
  readonly listActive: () => readonly ActiveProfile[];
  // Resolves a profile's Binance client AND the env it points at, so the
  // handler can scan testnet and live separately (different accounts).
  readonly resolveBinance: (
    operatorId: UserId,
    accountId: AccountId,
  ) => Promise<{
    rest: { getOpenOrders: BinanceRestClient['getOpenOrders'] };
    mode: BinanceMode;
  } | null>;
  // Tracked live ids tagged with the OWNING ACCOUNT, so each account is diffed
  // only against its own ids (order ids repeat across accounts).
  readonly listTrackedLiveOrderIds: () => Promise<
    readonly { binanceOrderId: bigint; accountId: AccountId }[]
  >;
  // Two-tick confirmation: returns the subset of this ACCOUNT's candidate ids that
  // were also candidates last tick, suppressing transient false orphans from the
  // reprice race (see store.confirmPersisted). Rewrites the account's seen set as a
  // side effect — hence account-scoped: an account skipped this tick (its
  // getOpenOrders failed) must have its set left alone, not pruned to empty.
  readonly confirmPersistedOrphans: (
    accountId: AccountId,
    currentIds: readonly string[],
  ) => Promise<readonly string[]>;
  readonly computeNewOrphans: (
    accountId: AccountId,
    currentIds: readonly string[],
  ) => Promise<readonly string[]>;
  readonly commitAlerted: (accountId: AccountId, deliveredIds: readonly string[]) => Promise<void>;
  // Persist ONE account's current orphan set so the api's `/orphan-orders` route
  // can serve it without a Binance round-trip. Written every tick per scanned
  // account (including the empty set) so an adopted or cancelled order drops off
  // the adopt UI.
  readonly writeSnapshot: (accountId: AccountId, snapshot: OrphanSnapshot) => Promise<void>;
  readonly nowMs: () => number;
  // The account-notify chokepoint, in its batch form. It owns the subscription
  // gate, the account-scoped notifier resolve, and the fan-out; the cron only
  // decides which orphans are worth an alert and what to do with each outcome.
  // Batch because one account's orphans share one gate and one notifier set.
  readonly accountNotify: AccountNotifyEventBatch;
  // Durable trace for an alert that reached nobody. Only fires when the orphan's
  // own account has no notifier at all — a mute is the operator's choice, not a
  // gap.
  readonly recordNotifyGap: (orphan: OrphanOrder) => Promise<void>;
  /** Public base URL (`PUBLIC_WEB_URL`) for the "Review" deep link; omitted when unset. */
  readonly publicWebUrl?: string;
}

export const orphanOrdersDetectHandler =
  (deps: OrphanOrdersDetectDeps) =>
  async (_job: Job): Promise<void> => {
    const profiles = deps.listActive();
    if (profiles.length === 0) {
      deps.logger.debug('cron orphan-orders-detect: no active profiles; skipped');
      return;
    }
    // One Binance client per DISTINCT ACCOUNT. Each account is its own key pair
    // and its own order book, so each must be scanned on its own: keying by mode
    // instead would cover only the first account found per environment and leave
    // every sibling account's untracked orders invisible.
    const clients = new Map<
      AccountId,
      {
        rest: { getOpenOrders: BinanceRestClient['getOpenOrders'] };
        mode: BinanceMode;
        operatorId: UserId;
      }
    >();
    for (const p of profiles) {
      if (clients.has(p.accountId)) continue;
      const resolved = await deps.resolveBinance(p.operatorId, p.accountId);
      if (resolved) {
        clients.set(p.accountId, {
          rest: resolved.rest,
          mode: resolved.mode,
          operatorId: p.operatorId,
        });
      }
    }
    if (clients.size === 0) {
      deps.logger.warn(
        'cron orphan-orders-detect: no Binance credentials on any active profile; skipped',
      );
      return;
    }

    // Tracked ids bucketed by account: diff each account only against ids tracked
    // on THAT account (order ids repeat across accounts, so a global set would let
    // one account mask another's orphan).
    const trackedByAccount = new Map<AccountId, Set<bigint>>();
    for (const t of await deps.listTrackedLiveOrderIds()) {
      const bucket = trackedByAccount.get(t.accountId);
      if (bucket) bucket.add(t.binanceOrderId);
      else trackedByAccount.set(t.accountId, new Set([t.binanceOrderId]));
    }

    // Everything below is per SCANNED account. An account whose `getOpenOrders`
    // failed is skipped entirely — no snapshot rewrite, no seen/alerted rewrite —
    // so its state survives untouched to the next tick instead of being pruned as
    // "no orphans here".
    let totalOrphans = 0;
    let totalNew = 0;
    let totalSettled = 0;
    for (const [accountId, { rest, mode }] of clients) {
      let openOrders: readonly OpenOrderDto[];
      try {
        openOrders = await rest.getOpenOrders();
      } catch (err) {
        // Skip only THIS account. Aborting the whole tick would let one account's
        // transient Binance failure suppress every other account's detection —
        // including a real-money orphan on a healthy account. This account's last
        // good snapshot rides its TTL and we retry it next tick.
        deps.logger.warn(
          { err: err, accountId, mode },
          'cron orphan-orders-detect: getOpenOrders failed for this account (will retry next tick)',
        );
        continue;
      }
      const accountOrphans = selectOrphans(
        openOrders,
        trackedByAccount.get(accountId) ?? new Set<bigint>(),
      ).map((o) => toOrphanOrder(o, mode, accountId));
      totalOrphans += accountOrphans.length;

      // Persist this account's set (even when empty) so its adopt UI always
      // reflects the latest detection, independent of the alert dedup below. A
      // snapshot-write failure must not block alerting.
      try {
        await deps.writeSnapshot(accountId, {
          computedAtMs: deps.nowMs(),
          orphans: accountOrphans,
        });
      } catch (err) {
        deps.logger.warn(
          { err: err, accountId },
          'cron orphan-orders-detect: snapshot write failed (adopt UI may be stale)',
        );
      }

      // Two-tick confirmation BEFORE the once-per-orphan dedup: only alert an
      // orphan seen on two consecutive ticks. The snapshot above (adopt UI) keeps
      // the raw live diff; this gates only the push alert, so a transient false
      // orphan from the bot's cancel/replace reprice churn — present in one
      // point-in-time `getOpenOrders()` snapshot but gone by the next tick — never
      // fires a notification. The seen set is rewritten as a side effect.
      const ids = accountOrphans.map((o) => o.orderId);
      const confirmedIds = new Set(await deps.confirmPersistedOrphans(accountId, ids));
      const confirmed = accountOrphans.filter((o) => confirmedIds.has(o.orderId));
      const newIds = new Set(await deps.computeNewOrphans(accountId, [...confirmedIds]));
      if (newIds.size === 0) continue;
      totalNew += newIds.size;

      // ONE batch per account: the subscription gate and the notifier resolve give
      // the same answer for every orphan of an account, so reading them per orphan
      // was N pointless round trips. The sends inside a batch stay serialized
      // (notifier rate limits).
      const alertable = confirmed.filter((o) => newIds.has(o.orderId));
      for (const o of alertable) {
        deps.logger.warn(
          {
            orderId: o.orderId,
            accountId: o.accountId,
            symbol: o.symbol,
            clientOrderId: o.clientOrderId,
            side: o.side,
            mode: o.mode,
          },
          'cron orphan-orders-detect: untracked exchange order',
        );
      }
      const outcomes: readonly AccountNotifyOutcome[] = await deps.accountNotify({
        category: 'orphan-order',
        // The orphan sits on exactly one order book, owned by exactly one key
        // pair, so only THAT account's notifiers are the right audience — an
        // env-wide fan-out would tell a sibling live account about it.
        accountId,
        events: alertable.map((o) => ({
          symbol: o.symbol,
          body: `Found an untracked ${o.mode === 'live' ? 'live' : 'testnet'} order on Binance. The bot is not managing it; review it on the Orphan orders screen or cancel it on Binance.`,
          fields: [
            { label: 'Order ID', value: String(o.orderId) },
            { label: 'Side', value: o.side },
            { label: 'Amount', value: `${o.origQty} @ ${o.price}` },
          ],
          // The adopt screen is account-scoped, so the link must name the account
          // the orphan was found on — a bare `/account/orphan-orders` is not a
          // route and drops the operator on a not-found page.
          ...(deps.publicWebUrl
            ? { link: `${deps.publicWebUrl}/accounts/${o.accountId}/orphan-orders` }
            : {}),
        })),
      });

      // Commit an orphan only when the alert is settled, so a transient notifier
      // outage (`failed`) re-alerts next tick rather than silently dropping the
      // only warning. A mute or a missing notifier is settled: the operator either
      // chose silence or has a durable trace, and re-warning every tick would only
      // build a backlog that storms them the moment they re-enable the category.
      const settled: string[] = [];
      for (const [i, o] of alertable.entries()) {
        const outcome = outcomes[i] ?? 'failed';
        if (outcome === 'no-notifier') await deps.recordNotifyGap(o);
        if (outcome !== 'failed') settled.push(o.orderId);
      }
      await deps.commitAlerted(accountId, settled);
      totalSettled += settled.length;
    }

    deps.logger.info(
      { newOrphans: totalNew, settled: totalSettled, totalOrphans },
      'cron orphan-orders-detect: complete',
    );
  };

/**
 * Durable trace for an orphan alert that reached nobody. `action_logs` rows are
 * profile-scoped and an orphan has no owning profile, so the row lands on the
 * profiles of the orphan's OWN account — the same account the alert's deep link
 * points at, and the pages the operator is looking at when they wonder why
 * nothing warned them. The orphan already carries its `accountId`, so selecting
 * those profiles costs no query at all.
 *
 * The throttle is checked BEFORE any DB work: a standing gap would otherwise pay
 * for reads whose write it then drops. Best-effort throughout — a failed trace
 * must not fail the cron.
 */
const recordOrphanNotifyGap = async (ctx: BootContext, orphan: OrphanOrder): Promise<void> => {
  try {
    for (const p of ctx.listActive()) {
      if (p.accountId !== orphan.accountId) continue;
      if (!(await ctx.notifierGapThrottle.allow(`${p.profileId}:orphan-order`))) continue;
      const scoped = await profileRepo(ctx.db, p.operatorId, p.accountId, p.profileId);
      await scoped.actionLogs.append({
        time: new Date(),
        symbol: orphan.symbol,
        level: 'warn',
        msg: 'An untracked order was found on Binance but this account has no notifier set up — you were not alerted',
        ctx: { topic: 'orphan-order', orderId: orphan.orderId, mode: orphan.mode },
      });
    }
  } catch (err) {
    ctx.logger.warn(
      { err: err, orderId: orphan.orderId },
      'cron orphan-orders-detect: notifier-gap trace failed',
    );
  }
};

export const buildOrphanOrdersDetectCron = (ctx: BootContext): CronDef => {
  const store = createOrphanAlertStore(ctx.redis);
  return defineCron({
    name: 'orphan-orders-detect',
    queue: QUEUE_NAMES.orphanOrdersDetect,
    // Every 10 minutes: an orphan is not time-critical (it just sits open),
    // and the account-wide `getOpenOrders()` (no symbol) costs Binance weight 80
    // (correctly reserved since #458). At this cadence the cost is negligible.
    pattern: '0 */10 * * * *',
    handler: orphanOrdersDetectHandler({
      logger: ctx.logger,
      listActive: ctx.listActive,
      resolveBinance: ctx.resolveBinanceWithMode,
      listTrackedLiveOrderIds: () => repo.orders.listLiveBinanceOrderIdsByAccount(ctx.db),
      confirmPersistedOrphans: store.confirmPersisted,
      computeNewOrphans: store.computeNew,
      commitAlerted: store.commitAlerted,
      writeSnapshot: (accountId, snapshot) =>
        ctx.redis
          .set(
            GLOBAL_KEYS.orphanSnapshot(accountId),
            JSON.stringify(snapshot),
            'EX',
            ORPHAN_SNAPSHOT_TTL_S,
          )
          .then(() => undefined),
      nowMs: () => Date.now(),
      accountNotify: ctx.accountNotifyBatch,
      recordNotifyGap: (orphan) => recordOrphanNotifyGap(ctx, orphan),
      ...(ctx.publicWebUrl ? { publicWebUrl: ctx.publicWebUrl } : {}),
    }),
  });
};
