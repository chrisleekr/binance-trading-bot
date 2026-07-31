// State + persistence spine shared by the tick handler and the reconcilers.
//
// ColdLoad and StatePort are hoisted ahead of the consumers that need them
// (fillAdopter, tickHandler) so ONE `statePort` instance is shared end-to-end.
// The metrics registry is minted here so the tick and state-commit paths record
// onto the same registry the admin /metrics route serves.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import { profileRepoFromScope, type Database, type ProfileScope } from '@app/db';
import { createMetricsRegistry, type MetricsRegistry } from '@app/observability';

import { strategies as strategiesRegistry } from 'strategies.js';
import type { NotifyEvent } from 'notifiers/notify-event.js';
import { createFillAdopter, type FillAdopter } from 'executor/fill-adopter.js';
import { createFillBackfiller, type FillBackfiller } from 'executor/fill-backfiller.js';
import { QUEUE_NAMES } from 'queues/queue-names.js';
import {
  createSymbolReconcileEnqueue,
  type SymbolReconcileRequest,
} from 'queues/symbol-reconcile-enqueue.js';
import { createAccountSnapshotStore, type AccountSnapshotStore } from 'crons/account-snapshot.js';
import type { ChainByKey } from 'lib/chain-by-key.js';
import type { QueueSet } from 'queues/queue-set.js';
import { createProductionColdLoad } from 'tick/cold-load.js';
import { createSymbolInfoCache } from 'tick/symbol-info-cache.js';
import { createStatePort, type StatePort } from 'state/state-port.js';
import { createWorkerMetricsSink } from '../metrics-sink.js';

import type { ResolveBinanceClient } from './binance-resolver.js';

export type PersistProfileState = (
  scope: ProfileScope,
  nextState: unknown,
  nextStrategyVersion: string,
) => Promise<void>;

export type PersistSymbolState = (
  scope: ProfileScope,
  symbol: string,
  nextState: unknown,
  nextStrategyVersion: string,
  expectedVersion: number | null,
) => Promise<boolean>;

export interface StatePersistenceDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly chain: ChainByKey;
  readonly resolveBinanceClient: ResolveBinanceClient;
  readonly queueSet: QueueSet;
  readonly notifyEvent: NotifyEvent;
}

export interface StatePersistence {
  readonly persistProfileState: PersistProfileState;
  readonly persistSymbolState: PersistSymbolState;
  readonly coldLoad: ReturnType<typeof createProductionColdLoad>;
  readonly symbolInfoCache: ReturnType<typeof createSymbolInfoCache>;
  readonly metricsRegistry: MetricsRegistry;
  readonly metrics: ReturnType<typeof createWorkerMetricsSink>;
  readonly statePort: StatePort;
  readonly fillAdopter: FillAdopter;
  readonly fillBackfiller: FillBackfiller;
  readonly enqueueSymbolReconcile: (input: SymbolReconcileRequest) => Promise<void>;
  readonly accountSnapshotStore: AccountSnapshotStore;
}

export const buildStatePersistence = ({
  db,
  redis,
  logger,
  chain,
  resolveBinanceClient,
  queueSet,
  notifyEvent,
}: StatePersistenceDeps): StatePersistence => {
  // Single-statement Postgres write so state + version land atomically. The
  // commit path's `withTimeout` enforces the per-query SLA and the executor-side
  // Redis SET is the durable hot copy; this row is the crash-only recovery
  // source consulted by `loadProfileState`. Declared before fillAdopter so the
  // adopter routes its version-aware mutate through the same atomic writer.
  const persistProfileState: PersistProfileState = async (
    scope,
    nextState,
    nextStrategyVersion,
  ) => {
    // Account-scoped write through the typed repo: `scope` already proves
    // ownership (via `scopeProfile`), so the write needs no ad-hoc `user_id`
    // gate — invariant #4's compile-time guard now covers this path.
    const p = profileRepoFromScope(scope);
    const updated = await p.profile.commitState(nextState, nextStrategyVersion);
    if (updated === 0) {
      // Race: profile was deleted (or re-owned) after the scope was proven. No
      // silent failure — emit a warn so the operator sees the orphan write. The
      // caller does not retry; the next tick re-resolves and exits the "no
      // profile context" branch.
      logger.warn(
        { profileId: scope.profileId, operatorId: scope.operatorId, accountId: scope.accountId },
        'persistProfileState: 0 rows updated (deleted mid-tick?)',
      );
    }
  };

  // Per-(profile, symbol) atomic two-column upsert into `symbol_states` so each
  // symbol's strategy state lives in its own row — concurrent ticks for different
  // symbols of the same profile no longer race a shared blob.
  const persistSymbolState: PersistSymbolState = async (
    scope,
    symbol,
    nextState,
    nextStrategyVersion,
    expectedVersion,
  ) => {
    // `casUpsert` writes `WHERE version = expectedVersion` (or inserts when
    // null): a concurrent writer that already advanced the row returns `null` (a
    // CAS miss), surfaced here as `false` so the caller retries (fill) or skips
    // (tick commit). The `symbol_states.profile_id` FK cascades on delete, so a
    // profile deleted after the scope was proven leaves no row to write.
    const p = profileRepoFromScope(scope);
    const row = await p.symbolStates.casUpsert(
      symbol,
      { state: nextState, strategyVersion: nextStrategyVersion },
      expectedVersion,
    );
    return row !== null;
  };

  // ColdLoad and StatePort depend only on primitives already in scope, and are
  // hoisted so a single `statePort` is shared by fillAdopter and tickHandler.
  const coldLoad = createProductionColdLoad({
    db,
    redis,
    logger,
    resolveBinance: resolveBinanceClient,
  });

  // Symbol-info is a process-wide concern (one cache per worker). Its own deep
  // module owns the cache + Redis copy + per-mode exchange-info refresh on miss,
  // so a first test-mode miss primes testnet's keyspace from testnet's host.
  const symbolInfoCache = createSymbolInfoCache({
    redis,
    logger,
  });

  // Process-wide metrics registry + the record() sink the tick and state-commit
  // paths emit through. Built before the handlers so they record onto the same
  // registry the admin /metrics route serves.
  const metricsRegistry = createMetricsRegistry({ service: 'worker' });
  const metrics = createWorkerMetricsSink(metricsRegistry);

  const statePort = createStatePort({
    redis,
    logger,
    registry: strategiesRegistry,
    coldLoad,
    persistSymbolState,
    metrics,
  });

  const fillAdopter = createFillAdopter({
    db,
    chain,
    logger,
    statePort,
    registry: strategiesRegistry,
    // A SELL fill that empties a position enqueues the archive job so the
    // closed cycle snapshots into `trade_archive` without an operator click.
    pipelineQueue: queueSet.queues.pipeline,
    // Read on SELL fills to resolve LOT_SIZE stepSize for the sub-step dust flatten.
    symbolInfo: symbolInfoCache,
    // Fires the (default-off) `order-filled` operator alert on a fresh fill.
    notifyEvent,
  });

  // Recovers fills missed during a user-stream disconnect (Binance never replays
  // pre-resubscribe stream events). Runs on user-stream reconnect via the
  // event-router, folding `getMyTrades` results through the same idempotent
  // fill-adopter.
  const fillBackfiller = createFillBackfiller({
    db,
    resolveBinanceClient,
    fillAdopter,
    logger,
  });

  // The deferral seam every discover-a-missed-fill path shares. A Redis push is
  // safe inside the tick's chain lock; the adoption it schedules is not, which is
  // the whole reason the queue exists. `jobId` coalesces a burst for one
  // (profile, symbol) into a single converge pass.
  const enqueueSymbolReconcile = createSymbolReconcileEnqueue(
    queueSet.queues[QUEUE_NAMES.symbolReconcile],
  );

  // Shared account-info store: the safety cron writes here on its 5s tick, and
  // the event-router writes here on every `outboundAccountPosition` WS frame so
  // the dashboard reflects post-fill wallet balances within one round-trip.
  const accountSnapshotStore = createAccountSnapshotStore(redis);

  return {
    persistProfileState,
    persistSymbolState,
    coldLoad,
    symbolInfoCache,
    metricsRegistry,
    metrics,
    statePort,
    fillAdopter,
    fillBackfiller,
    enqueueSymbolReconcile,
    accountSnapshotStore,
  };
};
