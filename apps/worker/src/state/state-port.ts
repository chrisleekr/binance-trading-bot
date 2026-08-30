// StatePort: single boundary for per-(profile, symbol) strategy-state
// reads, commits, and version-safe mutations.
//
// Three primitives (`loadSymbolStateForTick`, `commitSymbolStateForTick`,
// `mutateSymbolState`) share one `reconcileAndMigrate` spine in
// `version-aware-mutate.ts`; this port bundles their deps once at boot so
// consumers (tick-handler, fill-adopter, future reset paths) take a
// single dep instead of a fistful of closures. The wins:
//
//   - Tests build one fake port instead of many closures.
//   - Boot-context wires the deps in one place; circular DI back-refs are
//     eliminated.
//   - The tick read/commit and the fill-adopter mutate cannot drift apart
//     on schemaVersion reconciliation — they route through one spine.
//
// Concurrency: callers MUST hold the `chainByKey` lock for
// `(profileId, symbol)` before calling any method. The port does not
// re-acquire the lock so it stays composable inside existing serialised
// callers.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { unwrapId } from '@app/contracts';
import type { ProfileScope, profileRepo } from '@app/db';
import {
  commitSymbolStateForTick,
  loadSymbolStateForTick,
  mergeLatchFieldsOnCasMiss,
  mutateSymbolState,
  type LatchMergeStrategy,
  type MergeLatchDeps,
  type MutateSymbolStateDeps,
  type PersistSymbolState,
  type ReconciledRead,
  type StateMutator,
  type StrategyLookup,
  type SymbolStateStrategyShape,
} from 'state/version-aware-mutate.js';
import type { MetricsSink } from 'metrics/catalog.js';
import type { SnapshotColdLoad } from 'tick/snapshot-loader.js';

export type { StateMutator, StrategyLookup, ReconciledRead, MetricsSink };

/**
 * The read result the tick handler holds between `strategy.tick` and the
 * durable commit. `state` is the migrated body the strategy runs on;
 * `commit` writes the strategy's next body back, stamped at the version the
 * read settled on. That version is captured inside the closure, never
 * exposed — so a caller cannot commit a body under the wrong stamp, and the
 * stamp/body lockstep is structural rather than convention. `timeoutMs`
 * bounds the PG write (a stalled persister degrades to a warn so the tick
 * continues; see `commitSymbolStateForTick`).
 */
export interface StateLoad {
  readonly state: unknown;
  readonly commit: (nextState: unknown, timeoutMs: number) => Promise<void>;
}

export interface StatePort {
  /**
   * Tick read path. Reconciles the already-pipelined `cachedBody` against
   * the durable PG row by schemaVersion, cold-loads + seeds on miss, then
   * migrates. Returns a {@link StateLoad} — the body `strategy.tick` should
   * run on plus a `commit` closure that already captured the version the
   * read settled on. Throws on migration failure (tick DLQs, durable row
   * untouched).
   */
  loadForTick(
    scope: ProfileScope,
    symbol: string,
    strategy: SymbolStateStrategyShape,
    config: unknown,
    cachedBody: string | null,
  ): Promise<StateLoad>;

  /**
   * Apply `mutate` to the per-(profile, symbol) strategy slice version-
   * safely. Routes through the same reconcile + migrate spine as the tick
   * read, then persists via the atomic two-column writer.
   */
  mutate(
    scope: Awaited<ReturnType<typeof profileRepo>>,
    symbol: string,
    mutate: StateMutator,
  ): Promise<void>;
}

export interface StatePortDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly registry: StrategyLookup;
  readonly coldLoad: Pick<SnapshotColdLoad, 'loadSymbolState'>;
  readonly persistSymbolState: PersistSymbolState;
  /** Forwarded to the commit path's persist-degrade counters. Optional; omitting it leaves the degrade warn-only. */
  readonly metrics?: MetricsSink;
}

export const createStatePort = (deps: StatePortDeps): StatePort => {
  const mutateDeps: MutateSymbolStateDeps = {
    redis: deps.redis,
    logger: deps.logger,
    registry: deps.registry,
    persistSymbolState: deps.persistSymbolState,
  };
  const commitDeps = {
    redis: deps.redis,
    logger: deps.logger,
    persistSymbolState: deps.persistSymbolState,
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
  };
  const mergeDeps: MergeLatchDeps = {
    redis: deps.redis,
    logger: deps.logger,
    persistSymbolState: deps.persistSymbolState,
    coldLoad: deps.coldLoad,
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
  };
  // A strategy declares `mergeConcurrent` only when it stamps exit latches that
  // outlive the position; the tick commit's CAS-miss recovery is a no-op skip
  // for the rest.
  const hasMergeConcurrent = (s: SymbolStateStrategyShape): s is LatchMergeStrategy =>
    typeof s.mergeConcurrent === 'function';
  return {
    loadForTick: async (scope, symbol, strategy, config, cachedBody) => {
      const { state, workingVersion, expectedVersion } = await loadSymbolStateForTick(
        { redis: deps.redis, logger: deps.logger, coldLoad: deps.coldLoad },
        scope,
        symbol,
        strategy,
        config,
        cachedBody,
      );
      // `workingVersion` (schema stamp) and `expectedVersion` (CAS token) are
      // captured here and never escape: the only way to commit is this closure,
      // so the durable stamp matches the body the read settled on, and the CAS
      // write is `WHERE version = expectedVersion` — a fill that landed on
      // another pod mid-tick makes the commit a no-clobber miss.
      return {
        state,
        commit: async (nextState, timeoutMs) => {
          const outcome = await commitSymbolStateForTick(
            commitDeps,
            scope,
            symbol,
            nextState,
            workingVersion,
            expectedVersion,
            timeoutMs,
          );
          // A concurrent fill won the version mid-tick (only possible at
          // replicas>1). Graft the tick's exit-latch fields onto the winner so
          // a lost commit cannot drop a loss-cooldown into a re-buy. Strategies
          // without `mergeConcurrent` keep the safe skip.
          if (outcome === 'cas-miss' && hasMergeConcurrent(strategy)) {
            // Fail-soft like the tick commit itself: a real DB/Redis error during
            // the latch merge (a persist throw, dropped connection) must NOT
            // reject the tick — that would DLQ it and re-run the strategy. Drop
            // the latch (its documented fallback) and
            // let the tick continue. CAS misses and migration failures are
            // already handled inside the merge (bounded retry, then drop).
            try {
              await mergeLatchFieldsOnCasMiss(
                mergeDeps,
                scope,
                symbol,
                strategy,
                config,
                nextState,
              );
            } catch (err) {
              deps.metrics?.record('state_commit_latch_merge_error', 1, {
                profileId: unwrapId(scope.profileId),
                symbol,
              });
              deps.logger.warn(
                { profileId: scope.profileId, symbol, err: err },
                'latch-merge errored; latch dropped, tick continues',
              );
            }
          }
        },
      };
    },
    mutate: (scope, symbol, mutator) => mutateSymbolState(mutateDeps, scope, symbol, mutator),
  };
};
