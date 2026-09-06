// Event router + user-data stream pool.
//
// Both are PRIVATE long-lived subsystems: the router turns WS user/market events
// into ticks and reconciles, the pool owns the per-account user-data socket. They
// are returned to the composer only so the fleet builder and lifecycles can wire
// them; neither is exposed on BootContext. The router is built before the pool
// because the pool's handlers call back into the router.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import type { Database } from '@app/db';

import { createEventRouter } from 'event-router/event-router.js';
import { createClassifyOrder } from 'event-router/classify-order.js';
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
    classifyOrder: createClassifyOrder({ db, redis, logger }),
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
