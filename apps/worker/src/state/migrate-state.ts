// Shared state-migration loop.
//
// Strategies declare a `migrateState` per-version hop. The worker has two
// paths that need to walk that chain:
//
//   - Boot reconciler (`reconcile-held-quantity.ts`): upgrades a persisted
//     state row to the strategy's current schema before reconciliation.
//   - Out-of-band mutations (fill-adopter, future reset paths): the Redis
//     cache may carry a state shape from a prior schema; mutating that row
//     would write back a stale shape and clobber the durable `strategy_version`
//     stamp on PG.
//
// Both share the same algorithm: walk `migrateState` one hop at a time,
// guard against cycles, bail at a max-hops cap. Extracting it here keeps a
// single source of truth for the loop semantics.

import type { Logger } from 'pino';

/**
 * Minimal structural view of a strategy plugin's migration surface.
 * Mirrors the relevant fields on `AnyStrategy` without forcing the call
 * site to import the full plugin contract.
 */
export interface MigrationStrategyShape {
  readonly name: string;
  readonly version: string;
  migrateState?(input: { readonly fromVersion: string; readonly state: unknown }): unknown;
}

const MAX_MIGRATION_HOPS = 16;

const readStateSchemaVersion = (state: unknown): string | null => {
  if (!state || typeof state !== 'object') return null;
  const sv = (state as Record<string, unknown>)['schemaVersion'];
  return typeof sv === 'string' ? sv : null;
};

/**
 * Outcome of a migration walk. `migrated === false` means the input was
 * already at-version OR the strategy declares no `migrateState` — callers
 * treat it as a no-op (state/version unchanged). On migrated success,
 * `state` is the post-walk shape and `version` is the strategy's current
 * version. On failure (cycle, cap, throw) the function returns `null` so
 * the caller can decide whether to skip-and-defer or fail loud — keeping
 * that policy at the call site means the boot reconciler can swallow and
 * log while a mutate path can fail the operation.
 */
export type MigrationResult =
  | { readonly migrated: false }
  | { readonly migrated: true; readonly state: unknown; readonly version: string };

export interface MigrateStateInput {
  readonly strategy: MigrationStrategyShape;
  readonly fromVersion: string;
  readonly state: unknown;
  readonly logger: Logger;
  readonly logContext: Record<string, unknown>;
}

/**
 * Walks the strategy's `migrateState` from `fromVersion` to
 * `strategy.version`, returning the migrated state + final version. Pure
 * w.r.t. persistence — the caller decides how to commit.
 *
 * Returns `null` on any failure (cycle, hop cap exceeded, exception from
 * `migrateState`), having logged the reason against `logContext`. Returns
 * `{ migrated: false }` when no migration was needed (already at-version
 * or no migrateState declared).
 */
export const runStateMigration = async (
  input: MigrateStateInput,
): Promise<MigrationResult | null> => {
  // The caller-supplied `fromVersion` is the durable
  // version stamp on the row (PG `strategy_version` column for the boot
  // path, Redis cache header for the mutate path). When that stamp
  // drifts away from `state.schemaVersion` — past write touched only
  // one side — the column lies. The state body is the authoritative
  // shape; the hop loop below already enforces this via cycle-detection
  // on `(state as { schemaVersion })`. Prefer the state stamp here too
  // so the divergence self-heals (`persistMigratedState` writes both
  // columns atomically after a successful migration).
  const stateSchemaVersion = readStateSchemaVersion(input.state);
  if (stateSchemaVersion !== null && stateSchemaVersion !== input.fromVersion) {
    input.logger.warn(
      {
        ...input.logContext,
        suppliedFromVersion: input.fromVersion,
        stateSchemaVersion,
      },
      'runStateMigration: state.schemaVersion diverges from supplied fromVersion; trusting state.schemaVersion',
    );
  }
  const effectiveFromVersion = stateSchemaVersion ?? input.fromVersion;
  if (effectiveFromVersion === input.strategy.version) {
    // Body is already at-version. If the caller-supplied fromVersion
    // (the durable column/cache stamp) lags behind, signal `migrated:
    // true` with the body unchanged so the caller writes the corrected
    // stamp through its atomic persister and the column heals on the
    // same boot. Same-version-on-both-sides stays a true no-op.
    if (stateSchemaVersion !== null && stateSchemaVersion !== input.fromVersion) {
      return { migrated: true, state: input.state, version: input.strategy.version };
    }
    return { migrated: false };
  }
  const migrate = input.strategy.migrateState;
  if (!migrate) {
    return { migrated: false };
  }
  try {
    let cursor = effectiveFromVersion;
    let migrated = input.state;
    const visited = new Set<string>([cursor]);
    let hops = 0;
    while (cursor !== input.strategy.version && hops < MAX_MIGRATION_HOPS) {
      migrated = await migrate({ fromVersion: cursor, state: migrated });
      const nextVer = (migrated as { schemaVersion?: unknown } | null)?.schemaVersion;
      if (typeof nextVer !== 'string' || visited.has(nextVer)) break;
      visited.add(nextVer);
      cursor = nextVer;
      hops += 1;
    }
    if (cursor !== input.strategy.version) {
      input.logger.warn(
        {
          ...input.logContext,
          fromVersion: effectiveFromVersion,
          targetVersion: input.strategy.version,
          cursor,
          hops,
        },
        'runStateMigration: did not reach target version',
      );
      return null;
    }
    return { migrated: true, state: migrated, version: input.strategy.version };
  } catch (err) {
    input.logger.warn(
      {
        ...input.logContext,
        err,
        fromVersion: effectiveFromVersion,
        targetVersion: input.strategy.version,
      },
      'runStateMigration: migrateState threw',
    );
    return null;
  }
};
