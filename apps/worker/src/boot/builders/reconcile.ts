// The held-quantity reconcile dep bags.
//
// ONE `reconcileDeps` is shared by the three callers that converge held
// quantity: the boot pass, the periodic backstop cron, and the symbol-reconcile
// job. It receives the SHARED `chain` (shorthand, not a fresh instance) so every
// reconcile write serialises with a concurrent fill on the same (profile,
// symbol) key — the single-chain guard pins this.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

import type { Database } from '@app/db';

import { strategies as strategiesRegistry } from 'strategies.js';
import type { ChainByKey } from 'lib/chain-by-key.js';
import type { MutateSymbolStateDeps } from 'state/version-aware-mutate.js';
import type { ReconcileOrchestratorDeps } from '../reconcile-held-quantity.js';
import type { ProfileManager } from 'profile-manager/profile-manager.js';

import type { PersistProfileState, PersistSymbolState } from './state-persistence.js';
import type { ResolveBinanceClient } from './binance-resolver.js';

export interface ReconcileDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly chain: ChainByKey;
  readonly profileManager: ProfileManager;
  readonly resolveBinanceClient: ResolveBinanceClient;
  readonly persistSymbolState: PersistSymbolState;
  readonly persistProfileState: PersistProfileState;
}

export interface Reconcile {
  readonly symbolStateDeps: MutateSymbolStateDeps;
  readonly reconcileDeps: ReconcileOrchestratorDeps;
}

export const buildReconcile = ({
  db,
  redis,
  logger,
  chain,
  profileManager,
  resolveBinanceClient,
  persistSymbolState,
  persistProfileState,
}: ReconcileDeps): Reconcile => {
  // Deps for `mutateSymbolState`; `persistSymbolState` already matches the
  // mutator's persister contract directly.
  const symbolStateDeps: MutateSymbolStateDeps = {
    redis,
    logger,
    registry: strategiesRegistry,
    persistSymbolState,
  };

  const reconcileDeps: ReconcileOrchestratorDeps = {
    db,
    redis,
    logger,
    listActive: () => profileManager.listActive(),
    resolveBinance: resolveBinanceClient,
    strategies: strategiesRegistry,
    persistMigratedState: persistProfileState,
    symbolStateDeps,
    chain,
  };

  return { symbolStateDeps, reconcileDeps };
};
