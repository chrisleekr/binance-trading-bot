// The live-trading executor: turns a strategy Decision into Binance order
// side effects, resolving per-profile bindings from either a proven scope (the
// tick already holds one) or a standalone ownership check.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import type { Database } from '@app/db';

import { notifyProviders as notifyProvidersRegistry } from 'notifiers.js';
import { strategies as strategiesRegistry } from 'strategies.js';
import { buildProfileBindings, buildProfileBindingsFromScope } from 'profile-bindings/index.js';
import { createLiveExecutor, type LiveExecutor } from 'executor/live-executor.js';
import { createThrottledReconcileEnqueue } from 'executor/reconcile-enqueue.js';
import type { ProfileManager } from 'profile-manager/profile-manager.js';

import type { StatePersistence } from './state-persistence.js';

export interface ExecutorDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly liveDemo: boolean;
  readonly profileManager: ProfileManager;
  readonly enqueueSymbolReconcile: StatePersistence['enqueueSymbolReconcile'];
}

export interface Executor {
  readonly liveExecutor: LiveExecutor;
}

export const buildExecutor = ({
  db,
  redis,
  logger,
  liveDemo,
  profileManager,
  enqueueSymbolReconcile,
}: ExecutorDeps): Executor => {
  const liveExecutor = createLiveExecutor({
    redis,
    notifyRegistry: notifyProvidersRegistry,
    liveDemo,
    strategies: strategiesRegistry,
    logger,
    // A tick hands down the scope it already proved (and the config scalars it
    // already read); anything else proves + reads standalone here.
    resolveProfile: (operatorId, accountId, profileId, scope, resolved) =>
      scope
        ? buildProfileBindingsFromScope({ db, logger }, scope, resolved)
        : buildProfileBindings({ db, logger }, operatorId, accountId, profileId),
    // THROTTLED: a decision handler's discovery repeats every tick for as long as
    // its cause holds (a -2010 SELL refused because the base asset is locked in a
    // resting order fires once a second, for days). Unthrottled, that is a
    // permanent reconcile treadmill on the shared Binance request-weight budget.
    // The cron backstop is deliberately NOT behind this window.
    enqueueSymbolReconcile: createThrottledReconcileEnqueue({
      redis,
      logger,
      // The decision handlers hold only (operatorId, profileId); the account is
      // bound per call by the executor, so resolve it from the active set here.
      // A profile with no active entry has nothing to reconcile.
      enqueue: async ({ profileId, symbol, cause }) => {
        const active = profileManager.listActive().find((p) => p.profileId === profileId);
        if (!active) return false;
        await enqueueSymbolReconcile({ accountId: active.accountId, profileId, symbol, cause });
        return true;
      },
    }),
  });

  return { liveExecutor };
};
