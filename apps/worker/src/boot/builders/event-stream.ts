// Event router + user-data stream pool.
//
// Both are PRIVATE long-lived subsystems: the router turns WS user/market events
// into ticks and reconciles, the pool owns the per-account user-data socket. They
// are returned to the composer only so the fleet builder and lifecycles can wire
// them; neither is exposed on BootContext. The router is built before the pool
// because the pool's handlers call back into the router.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import {
  accountRepo,
  AccountNotOwnedError,
  ProfileNotOwnedError,
  profileRepo,
  type Database,
} from '@app/db';
import { asProfileId, unwrapId, type ProfileId } from '@app/contracts';

import { createEventRouter } from 'event-router/event-router.js';
import { createUserStreamPool } from 'user-stream/user-stream-pool.js';
import { createStreamSilenceHandler } from 'user-stream/stream-silence-trace.js';
import type { NotifierGapThrottle } from 'executor/notifier-gap-throttle.js';
import type { ProfileManager } from 'profile-manager/profile-manager.js';
import type { FillAdopter } from 'executor/fill-adopter.js';
import type { FillBackfiller } from 'executor/fill-backfiller.js';
import type { AccountSnapshotStore } from 'crons/account-snapshot.js';
import type { QueueSet } from 'queues/queue-set.js';

import type { MarketData } from './market-data.js';
import type { StatePersistence } from './state-persistence.js';
import type { MetricsSink } from 'metrics/catalog.js';
import type { ResolveBinanceFull } from './binance-resolver.js';

export interface EventStreamDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly queueSet: QueueSet;
  readonly wsFactory: MarketData['wsFactory'];
  readonly profileManager: ProfileManager;
  readonly indicatorComputer: MarketData['indicatorComputer'];
  readonly fillAdopter: FillAdopter;
  readonly fillBackfiller: FillBackfiller;
  readonly accountSnapshotStore: AccountSnapshotStore;
  readonly notifierGapThrottle: NotifierGapThrottle;
  readonly enqueueSymbolReconcile: StatePersistence['enqueueSymbolReconcile'];
  /** Same sink the tick and commit paths hold, so the stream's own series land on one registry. */
  readonly metrics: MetricsSink;
  readonly resolveBinanceFull: ResolveBinanceFull;
}

export interface EventStream {
  readonly eventRouter: ReturnType<typeof createEventRouter>;
  readonly userStreamPool: ReturnType<typeof createUserStreamPool>;
}

export const buildEventStream = ({
  db,
  redis,
  logger,
  queueSet,
  wsFactory,
  profileManager,
  indicatorComputer,
  fillAdopter,
  fillBackfiller,
  accountSnapshotStore,
  notifierGapThrottle,
  enqueueSymbolReconcile,
  resolveBinanceFull,
  metrics,
}: EventStreamDeps): EventStream => {
  const eventRouter = createEventRouter({
    tickQueue: queueSet.queues.tick,
    redis,
    profileManager,
    indicatorComputer,
    fillAdopter,
    backfillFills: (operatorId, accountId, profileId, symbol) =>
      fillBackfiller.backfill(operatorId, accountId, profileId, symbol),
    mergeAccount: accountSnapshotStore.mergeAccount,
    // Cross-profile isolation gate. Resolves who owns the order id this report
    // refers to, from the receiving profile's point of view.
    //
    // The strategy `orders` table is ACCOUNT-domain, so one lookup answers "which
    // profile, if any, owns this id" for the whole account — no sibling
    // enumeration. A row whose `profile_id` is NULL is DETACHED: its profile was
    // deleted, so no profile may fold the fill into a position that no longer
    // exists, but the row itself must still be closed. It gets its own verdict so
    // the router can route it to the ledger-only reconcile instead of dropping it
    // on the floor.
    //
    // `manual_orders` is still profile-scoped and must be checked too: manual
    // orders rest on the same account and fill on the same stream, so skipping
    // them would re-open the leak through the manual surface. No match anywhere
    // means the order is no profile's YET — this profile's own just-placed order
    // whose row has not committed — so process it (adoption never waits on the
    // orders-row write). Any lookup failure folds to `sibling` (drop): for the
    // money path a dropped own report is recoverable (boot reconcile / next
    // report), whereas adopting a foreign one is not, so erring toward drop is
    // fail-safe. It must not fold to `detached` either — that would close a row
    // still resting on the exchange.
    classifyOrder: async (operatorId, accountId, profileId, binanceOrderId) => {
      const orderId = BigInt(binanceOrderId);
      try {
        const account = await accountRepo(db, operatorId, accountId);
        const row = await account.orders.findByBinanceOrderId(orderId);
        if (row) {
          if (row.profileId === null) return 'detached';
          return row.profileId === unwrapId(profileId) ? 'own' : 'sibling';
        }

        const ownsManual = async (id: ProfileId): Promise<boolean> =>
          (await (
            await profileRepo(db, operatorId, accountId, id)
          ).manualOrders.findByBinanceOrderId(orderId)) !== null;
        if (await ownsManual(profileId)) return 'own';
        for (const sibling of await account.profiles.listForAccount()) {
          const siblingId = asProfileId(sibling.id);
          if (siblingId === profileId) continue;
          if (await ownsManual(siblingId)) return 'sibling';
        }
        return 'own';
      } catch (err) {
        if (!(err instanceof ProfileNotOwnedError) && !(err instanceof AccountNotOwnedError)) {
          logger.warn(
            { operatorId, accountId, profileId, binanceOrderId, err: err },
            'event-router: order-ownership lookup failed; dropping execution report (fail-safe)',
          );
        }
        return 'sibling';
      }
    },
    logger,
  });

  const userStreamPool = createUserStreamPool({
    factory: wsFactory,
    logger,
    handlers: {
      onEvent: async (e) => {
        await eventRouter.onUserEvent(e);
      },
      onResync: async (uid, pid) => {
        await eventRouter.onProfileResync(uid, pid);
      },
    },
    // The socket answered our pings but delivered no ACCOUNT event for a long
    // while. That is NOT proof of a dead stream — `outboundAccountPosition`
    // fires only when a balance changes, so a profile holding a quiet position
    // legitimately emits nothing for hours — but it IS the condition under which
    // a missed fill would be invisible. So: reconnect (already done by the
    // watchdog), tell the operator in those terms, and converge every symbol of
    // the profile against exchange truth so a fill that fell in the gap is
    // adopted rather than silently lost.
    onStreamSilent: createStreamSilenceHandler({
      db,
      logger,
      notifierGapThrottle,
      symbolsOf: (profileId) =>
        profileManager.listActive().find((p) => p.profileId === profileId)?.symbols ?? [],
      enqueueSymbolReconcile,
    }),
    // Returns null when profile or key is missing so the user-stream pool logs
    // `no credentials available` instead of crashing — a profile can be enabled
    // before keys are saved during onboarding. Shares one findById + ownership
    // check with cold-load via `resolveBinanceFull`.
    resolveCredentials: resolveBinanceFull,
    // Counts each socket close. A flapping stream is otherwise invisible: the
    // pool reconnects, profiles keep ticking, and the only trace is a log line.
    metrics,
  });

  return { eventRouter, userStreamPool };
};
