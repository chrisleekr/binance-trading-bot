// Version-aware per-(profile, symbol) state boundary.
//
// Strategy state lives in `symbol_states` as one row per (profile,
// symbol). Three callers touch that row — the every-tick read, the
// every-tick commit, and the event-driven mutate (fill-adopter, future
// reset paths). Pre-#286 the tick read/commit hand-rolled their own I/O
// and skipped the reconciliation the mutate path used, reopening the
// exact divergence bugs this module exists to close:
//
//   - A Redis cache shape from an older schema could be mutated and
//     written back, leaving the durable PG row stamped at the new
//     `strategy_version` but carrying the old shape.
//   - A single-column / wrong-version write left `state` and
//     `strategy_version` out of lockstep (the tick used to stamp
//     `strategy.version` even when no migration ran).
//
// All three callers now route through one `reconcileAndMigrate` spine so
// the read/commit/mutate paths cannot drift apart again:
//
//   - Reads the durable `symbol_states` row for the symbol. A missing
//     row means no tick has run for this symbol yet, the strategy's
//     `initialState(config)` seeds the slice so a first fill or first
//     tick on a brand-new symbol still works against a coherent body.
//   - Trusts the Redis cache body only when its `schemaVersion` matches
//     the durable body's; any divergence falls back to the PG body.
//   - Runs the strategy's `migrateState` chain when the body lags the
//     registered strategy version, and reports the `workingVersion` the
//     body settled on so the commit stamps that version (never a blind
//     `strategy.version`).
//   - Persists via the atomic two-column `persistSymbolState` writer,
//     then updates the Redis cache. PG-first because PG is the recovery
//     source; a Redis stale-cache window between the two writes is
//     healed by the next read.
//
// Concurrency: the caller MUST hold the `chainByKey` lock for
// `(profileId, symbol)` before calling. Without the lock two concurrent
// fills (or a fill racing a tick) on the same symbol could interleave
// read/migrate/write and lose one mutation. The spine does not
// re-acquire the lock so it stays composable inside callers that already
// serialise on the same key.

import type { Logger } from 'pino';
import type { Redis } from 'ioredis';
import { profileRepo, type ProfileScope } from '@app/db';
import { unwrapId, type ProfileId, type AccountId } from '@app/contracts';
import { buildSymbolStateKey } from 'executor/redis-namespace.js';
import type { MetricsSink } from 'metrics/catalog.js';
import { runStateMigration, type MigrationStrategyShape } from 'state/migrate-state.js';
import type { SymbolStateRowView } from 'tick/snapshot-loader.js';
import { errorMessage } from '@app/core/error';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// Bounded optimistic-concurrency retries for the event-driven mutate path. A
// CAS miss means a concurrent writer won; five re-reads cover any realistic
// contention on one (profile, symbol) slice (a tick racing a fill). Exhausting
// them throws rather than spinning.
const MAX_CAS_RETRIES = 5;

/**
 * Caller-supplied mutate. Returns `null` to signal no change; both the
 * PG write and the Redis update are skipped in that case so callers can
 * de-duplicate on a per-event basis without a separate guard.
 */
export type StateMutator = (state: unknown) => unknown | null;

/**
 * Strategy plugin surface this module depends on. Wider than
 * `MigrationStrategyShape` because we also need `initialState(config)` to
 * seed a brand-new symbol slice, a fill or tick on a symbol the strategy
 * has never ticked for must work against a real body, not `null`.
 */
export interface SymbolStateStrategyShape extends MigrationStrategyShape {
  initialState(config: unknown): unknown;
  /**
   * Optional latch-field reconcile for a tick-commit CAS miss. Present on
   * strategies that stamp non-re-derivable exit latches (TT's cooldowns /
   * re-arm); absent strategies fall back to the conservative skip. Structural
   * mirror of the `@app/strategy-core` contract method — see its JSDoc.
   */
  mergeConcurrent?(input: { readonly base: unknown; readonly latchSource: unknown }): unknown;
}

/**
 * Minimal structural view of the strategy registry, narrow enough that
 * both the production `StrategyRegistry` and a test stub satisfy it.
 */
export interface StrategyLookup {
  get(name: string): SymbolStateStrategyShape | undefined;
}

/**
 * Atomic two-column writer for one (profile, symbol) row. Routes to the
 * boot-context `persistSymbolState`, which upserts through the typed
 * `ProfileScope` repo so `state` + `strategy_version` land in one UPSERT.
 * Takes the already-proven `scope` so ownership is never re-checked in
 * ad-hoc SQL (invariant #4); callers thread the single scope resolved at
 * tick entry.
 */
/**
 * Optimistic-concurrency durable write of one (profile, symbol) row.
 * `expectedVersion` is the CAS token the caller read (`null` when it read no
 * row and is seeding). Returns `true` when the write applied, `false` on a CAS
 * miss (a concurrent writer advanced `version` first) — the caller retries
 * (fill path) or skips without clobbering (tick commit). A `false` is never an
 * error; a genuine failure (FK violation, dropped connection) still throws.
 */
export type PersistSymbolState = (
  scope: ProfileScope,
  symbol: string,
  nextState: unknown,
  nextStrategyVersion: string,
  expectedVersion: number | null,
) => Promise<boolean>;

export interface MutateSymbolStateDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly registry: StrategyLookup;
  readonly persistSymbolState: PersistSymbolState;
}

/**
 * The migrated, ready-to-tick body plus the version it settled on. The
 * tick handler feeds `state` into `strategy.tick` and threads
 * `workingVersion` back into `commitSymbolStateForTick` so the durable
 * stamp matches the body — never re-derived at write time.
 */
export interface ReconciledRead {
  readonly state: unknown;
  readonly workingVersion: string;
  /**
   * The `version` CAS token the durable row carried at read, or `null` when no
   * row existed (the body was seeded — the write inserts at version 0). The
   * commit threads this back so the durable write is `WHERE version = expected`.
   */
  readonly expectedVersion: number | null;
}

interface ReconciledState extends ReconciledRead {
  /** False when the durable row was missing and the body was seeded. */
  readonly rowExisted: boolean;
  /** True when `migrateState` moved the body forward a version. */
  readonly migrated: boolean;
}

/**
 * Shared reconcile + migrate spine. Given the durable PG row (or `null`
 * to seed) and the current Redis cache body, settles on the body the
 * strategy should see and the version it should be stamped at. Pure
 * w.r.t. durable persistence — the caller commits. Clears an orphan /
 * malformed cache as a side effect so a stale body cannot win the next
 * read. Returns `null` on migration failure so the caller decides
 * whether to throw (tick / mutate both fail loud).
 */
const reconcileAndMigrate = async (
  deps: { readonly redis: Redis; readonly logger: Logger },
  accountId: AccountId,
  profileId: ProfileId,
  symbol: string,
  strategy: SymbolStateStrategyShape,
  config: unknown,
  row: SymbolStateRowView | null,
  cachedBody: string | null,
): Promise<ReconciledState | null> => {
  // Missing row = no tick has run for this symbol yet; seed from the
  // strategy. A seeded slice can't have lagged the registered version,
  // so its workingVersion is the current strategy.version.
  let workingState: unknown;
  let workingVersion: string;
  if (row === null) {
    workingState = strategy.initialState(config);
    workingVersion = strategy.version;
  } else {
    workingState = row.state;
    workingVersion = row.strategyVersion;
  }

  const stateKey = buildSymbolStateKey(accountId, profileId, symbol);
  const pgSchemaVersion = isRecord(workingState) ? workingState['schemaVersion'] : undefined;

  // Trust the Redis cache only when its schema stamp agrees with PG's.
  // Any disagreement means an out-of-band write (operator SQL, prior
  // crash, migration race) or a stale body — PG is authoritative. When
  // there is no durable row the seed body wins; a stale cache from a
  // crashed-before-persist attempt must not survive.
  if (cachedBody !== null) {
    try {
      const cached = JSON.parse(cachedBody);
      const cachedVer = isRecord(cached) ? cached['schemaVersion'] : undefined;
      if (row !== null && cachedVer !== undefined && cachedVer === pgSchemaVersion) {
        workingState = cached;
      } else if (row === null) {
        await deps.redis.del(stateKey);
      } else {
        // Divergent cache with a present row: keep the cache as-is rather
        // than del it. The subsequent commit (writeStateThrough /
        // commitSymbolStateForTick) always overwrites the cache, so the
        // stale body is reconciled on the same call — no orphan window.
        deps.logger.info(
          { accountId, profileId, symbol, cachedVersion: cachedVer, pgVersion: pgSchemaVersion },
          'reconcileAndMigrate: Redis cache schemaVersion diverges from PG; using PG body',
        );
      }
    } catch {
      deps.logger.warn(
        { accountId, profileId, symbol },
        'reconcileAndMigrate: malformed Redis state; clearing and using PG body',
      );
      await deps.redis.del(stateKey);
    }
  }

  // Always route through runStateMigration so it can detect
  // strategy_version-vs-state.schemaVersion divergence. It short-circuits
  // cheaply when nothing needs migration and prefers the body's own
  // schemaVersion over the supplied column stamp, self-healing drift.
  const migration = await runStateMigration({
    strategy,
    fromVersion: workingVersion,
    state: workingState,
    logger: deps.logger,
    logContext: { accountId, profileId, symbol },
  });
  if (migration === null) return null;
  let migrated = false;
  if (migration.migrated) {
    workingState = migration.state;
    workingVersion = migration.version;
    migrated = true;
  }

  return {
    state: workingState,
    workingVersion,
    expectedVersion: row?.version ?? null,
    rowExisted: row !== null,
    migrated,
  };
};

/**
 * Apply `mutate` to one (profile, symbol) strategy slice, version-safely.
 *
 * `scope` is reused when the caller has already paid the per-profile
 * ownership check (`profileRepo`). Passing it through removes the extra
 * `scopeProfile` call any helper would otherwise make.
 *
 * Returns silently when:
 *   - The profile no longer exists (deletion race).
 *   - The strategy registered for the profile cannot be resolved.
 *   - The mutator returns `null` AND no migration ran AND a durable row
 *     already existed.
 *
 * Throws when migration fails so the caller's prior side-effects
 * (ledger writes, applied-fills SADDs) can roll back rather than
 * leaving an inconsistent slice on disk.
 */
export const mutateSymbolState = async (
  deps: MutateSymbolStateDeps,
  scope: Awaited<ReturnType<typeof profileRepo>>,
  symbol: string,
  mutate: StateMutator,
): Promise<void> => {
  const accountId = scope.scope.accountId as AccountId;
  const profileId = scope.scope.profileId as ProfileId;

  // Resolve strategy identity + config. The caller has already proven
  // ownership; this fetch only adds the registry key and the config blob
  // the strategy's `initialState` needs to seed a fresh slice.
  const profile = await scope.profile.findById();
  if (!profile) {
    deps.logger.warn(
      { accountId, profileId, symbol },
      'mutateSymbolState: profile not found; skipping',
    );
    return;
  }

  const strategy = deps.registry.get(profile.strategyName);
  if (!strategy) {
    // Unknown strategy = registry mis-wired. Refuse to mutate rather than
    // silently write a state body the strategy can't parse.
    deps.logger.warn(
      { accountId, profileId, symbol, strategyName: profile.strategyName },
      'mutateSymbolState: strategy not registered; skipping',
    );
    return;
  }

  // Optimistic-concurrency loop: read → reconcile → mutate → CAS write. On a
  // CAS miss (a concurrent writer — a tick, or another fill — advanced the
  // slice) re-read the fresh body and re-apply `mutate`, which composes on top
  // of the winner's change. Bounded so a pathological write storm surfaces
  // loudly rather than spinning; the caller's prior side effects (applied-fills
  // record) then reconcile on the next fill/tick.
  for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt += 1) {
    // The durable row and the cached body are independent inputs to the
    // reconcile; read them together so each CAS attempt pays one round-trip, not
    // two serial ones (and the pair reflects a tighter instant).
    const [row, cachedBody] = await Promise.all([
      scope.symbolStates.findBySymbol(symbol),
      deps.redis.get(buildSymbolStateKey(accountId, profileId, symbol)),
    ]);
    const reconciled = await reconcileAndMigrate(
      deps,
      accountId,
      profileId,
      symbol,
      strategy,
      profile.config,
      row,
      cachedBody,
    );
    if (reconciled === null) {
      throw new Error(
        `mutateSymbolState: migration to ${strategy.version} failed for profile ${unwrapId(
          profileId,
        )} symbol ${symbol}`,
      );
    }

    const next = mutate(reconciled.state);
    let applied: boolean;
    if (next === null) {
      // No-change mutate. Persist anyway when the durable row was missing
      // (seed lands as a real row for next time) or when migration moved
      // the version forward, both cases prevent a future call from repeating
      // the same seed/migration work. Otherwise there is nothing to write.
      if (!reconciled.rowExisted || reconciled.migrated) {
        applied = await writeStateThrough(
          deps,
          scope.scope,
          symbol,
          reconciled.state,
          reconciled.workingVersion,
          reconciled.expectedVersion,
        );
      } else {
        return;
      }
    } else {
      applied = await writeStateThrough(
        deps,
        scope.scope,
        symbol,
        next,
        reconciled.workingVersion,
        reconciled.expectedVersion,
      );
    }

    if (applied) return;
    deps.logger.info(
      { accountId, profileId, symbol, attempt },
      'mutateSymbolState: CAS miss; retrying on fresh state',
    );
  }
  throw new Error(
    `mutateSymbolState: CAS retries exhausted (${MAX_CAS_RETRIES}) for profile ${unwrapId(
      profileId,
    )} symbol ${symbol}`,
  );
};

/**
 * Refresh the Redis state cache after a durable PG write. PG is committed
 * first, so the cache can only lag PG, never lead it (except any
 * `commitSymbolStateForTick` degrade — persist error, FK violation, or
 * timeout — which now refreshes the cache to the intended body to preserve
 * read-your-writes; single replica only). The read path trusts the cache on a bare `schemaVersion`
 * match, and `schemaVersion` only moves on a migration — so two bodies at
 * the same version are indistinguishable. If `set` throws *after* PG
 * commits, the cache would hold a stale body at PG's version and the next
 * read would silently revert the committed state (#371). DEL the key on a
 * `set` failure so the next read falls back to the authoritative PG body.
 * A failed DEL is the one window a stale body can outlive committed PG
 * state; log it loudly rather than fail the write (the next successful
 * write self-heals it).
 */
const refreshStateCache = async (
  deps: { readonly redis: Redis; readonly logger: Logger },
  accountId: AccountId,
  profileId: ProfileId,
  symbol: string,
  state: unknown,
): Promise<void> => {
  const key = buildSymbolStateKey(accountId, profileId, symbol);
  try {
    await deps.redis.set(key, JSON.stringify(state));
  } catch (setErr) {
    try {
      await deps.redis.del(key);
      deps.logger.warn(
        { accountId, profileId, symbol, err: setErr },
        'refreshStateCache: cache set failed after PG commit; cleared the cache key so the next read falls back to PG',
      );
    } catch (delErr) {
      deps.logger.error(
        {
          accountId,
          profileId,
          symbol,
          setErr: errorMessage(setErr),
          delErr: errorMessage(delErr),
        },
        'refreshStateCache: cache set AND del both failed; a stale body may outlive committed PG state until the next successful write',
      );
    }
  }
};

/**
 * PG-first, Redis-second durable write of one (profile, symbol) row. Returns
 * whether the CAS write applied. The cache is refreshed ONLY on success: on a
 * CAS miss the winner's body is authoritative, so caching ours would let the
 * next read (which trusts a same-schemaVersion cache) silently revert the
 * winner.
 */
const writeStateThrough = async (
  deps: {
    readonly redis: Redis;
    readonly logger: Logger;
    readonly persistSymbolState: PersistSymbolState;
  },
  scope: ProfileScope,
  symbol: string,
  state: unknown,
  version: string,
  expectedVersion: number | null,
): Promise<boolean> => {
  const applied = await deps.persistSymbolState(scope, symbol, state, version, expectedVersion);
  if (applied) await refreshStateCache(deps, scope.accountId, scope.profileId, symbol, state);
  return applied;
};

export interface LoadSymbolStateForTickDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly coldLoad: {
    loadSymbolState(scope: ProfileScope, symbol: string): Promise<SymbolStateRowView | null>;
  };
}

/**
 * Tick read path. Reconciles the already-pipelined Redis cache body
 * (`cachedBody`, no extra Redis round-trip) against the durable PG row by
 * schemaVersion, cold-loads + seeds on miss, then migrates — returning
 * the body `strategy.tick` should run on plus the version the commit must
 * stamp. Throws on migration failure so the tick DLQs with the durable
 * row untouched.
 */
export const loadSymbolStateForTick = async (
  deps: LoadSymbolStateForTickDeps,
  scope: ProfileScope,
  symbol: string,
  strategy: SymbolStateStrategyShape,
  config: unknown,
  cachedBody: string | null,
): Promise<ReconciledRead> => {
  const row = await deps.coldLoad.loadSymbolState(scope, symbol);
  const reconciled = await reconcileAndMigrate(
    deps,
    scope.accountId,
    scope.profileId,
    symbol,
    strategy,
    config,
    row,
    cachedBody,
  );
  if (reconciled === null) {
    throw new Error(
      `loadSymbolStateForTick: migration to ${strategy.version} failed for profile ${unwrapId(
        scope.profileId,
      )} symbol ${symbol}`,
    );
  }
  return {
    state: reconciled.state,
    workingVersion: reconciled.workingVersion,
    expectedVersion: reconciled.expectedVersion,
  };
};

/**
 * Outcome of a tick commit. `cas-miss` is the seam the caller reacts to: a
 * concurrent fill won the version, so the caller (state-port) grafts the tick's
 * latch fields onto the winner via `mergeLatchFieldsOnCasMiss` when the strategy
 * supports it. `degraded` is a persist timeout/error (cache holds the only copy;
 * next tick re-persists). `applied` is a clean durable write.
 */
export type TickCommitOutcome = 'applied' | 'cas-miss' | 'degraded';

export interface CommitSymbolStateForTickDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly persistSymbolState: PersistSymbolState;
  /**
   * Bumped from the persist-degrade branches so a stuck PG persister is
   * alertable. Without it the degrade is warn-only: on a persist
   * timeout/error the Redis cache holds the only copy of the new body
   * until a later commit re-persists, so ticks stopping for that symbol
   * (delist, pause, kline gap) can leave PG stale-but-fresh-looking
   * indefinitely and unalertable.
   */
  readonly metrics?: MetricsSink;
}

/**
 * Tick commit path. Two-column durable write stamped at `workingVersion`
 * (the version the read settled on — never re-derived from the strategy)
 * plus a cache refresh. The PG write is raced against `timeoutMs`: a
 * slow/rejecting persister degrades to a warn so the tick continues and
 * never blocks the chain on a stalled PG.
 *
 * On a persist timeout/failure the Redis cache still holds `nextState`,
 * so it becomes the only copy of the new body until a later successful
 * commit re-persists it — there is no automatic retry, and a timed-out
 * persist is not cancelled (it may land out of order, healed by the next
 * commit). The `chainByKey` lock keeps these in-order per (profile,
 * symbol); cross-tick recovery relies on the next tick committing.
 */
export const commitSymbolStateForTick = async (
  deps: CommitSymbolStateForTickDeps,
  scope: ProfileScope,
  symbol: string,
  nextState: unknown,
  workingVersion: string,
  expectedVersion: number | null,
  timeoutMs: number,
): Promise<TickCommitOutcome> => {
  const tags = { profileId: unwrapId(scope.profileId), symbol };
  // `applied` stays undefined on a timeout or persist error (both degrade to a
  // warn so the tick continues); true/false only on a settled CAS write.
  let applied: boolean | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    deps
      .persistSymbolState(scope, symbol, nextState, workingVersion, expectedVersion)
      .then((ok) => {
        applied = ok;
      })
      .catch((err) => {
        deps.metrics?.record('state_commit_persist_error', 1, tags);
        deps.logger.warn(
          { profileId: scope.profileId, symbol, err: err },
          'persistSymbolState failed (tick continues; retry on next tick)',
        );
      })
      .finally(() => {
        if (timer) clearTimeout(timer);
      }),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        deps.metrics?.record('state_commit_persist_timeout', 1, tags);
        deps.logger.warn(
          { profileId: scope.profileId, symbol },
          `persistSymbolState exceeded ${timeoutMs}ms timeout`,
        );
        resolve();
      }, timeoutMs);
      timer?.unref?.();
    }),
  ]);

  if (applied === true) {
    await refreshStateCache(deps, scope.accountId, scope.profileId, symbol, nextState);
    return 'applied';
  }
  if (applied === false) {
    // CAS miss: a concurrent writer (a fill adopted on the stream-owner pod)
    // advanced the slice during this tick. Do NOT overwrite here — that would
    // lose-update the fill's authoritative position; and any order this tick
    // placed is idempotent at the exchange via clientOrderId. Leave the cache
    // alone so the next read reconciles the winner's body from PG.
    //
    // CANNOT happen at single replica: chainByKey serialises tick-vs-fill in
    // one process, so `version` never moves under a tick. It only fires once
    // replicas>1 is enabled — and at that point a bare skip would DROP this
    // tick's non-re-derivable latch fields (loss-exit / force-sell cooldowns,
    // auto-trigger re-arm, stamped once at the sell transition). The caller
    // (state-port) reacts to this `cas-miss` by grafting those latch fields
    // onto the winner via `mergeLatchFieldsOnCasMiss` when the strategy
    // supports it; strategies without `mergeConcurrent` keep the safe skip.
    deps.metrics?.record('state_commit_cas_miss', 1, tags);
    deps.logger.warn(
      { profileId: scope.profileId, symbol },
      'symbol_states CAS miss on tick commit; a concurrent writer won',
    );
    return 'cas-miss';
  }
  // applied === undefined: timeout or persist error, already logged + metered.
  // Refresh the cache to `nextState` anyway. The read path prefers the cache
  // over PG at equal schemaVersion (reconcileAndMigrate), so leaving the
  // pre-tick body in the cache breaks read-your-writes: the next serialized
  // tick re-reads the stale slice and re-derives the same decision. Observed
  // live: an L0 grid entry re-fired every tick through a PG-latency window,
  // placing duplicate MARKET buys until the quote balance drained. The numeric
  // CAS version is PG-sourced (row.version), never cached, so an optimistic
  // body cannot corrupt the version chain; the uncancelled PG write, if it
  // lands, carries the same body, and if it does not the next confirmed commit
  // heals PG. SINGLE REPLICA ONLY: chainByKey serialises tick-vs-fill in one
  // process, so the only out-of-band writer is this tick's own uncancelled PG
  // write — same body, CAS-guarded (WHERE version=expected), so it cannot
  // clobber (it may still CAS-miss a later tick, which is safe). When replicas>1
  // is enabled (dormant, epic #561), a degrade here could race a fill adopted
  // on the stream-owner pod and revert its authoritative position body in the
  // cache — this seam MUST be revisited then (block-until-confirmed for
  // order-placing ticks, or a version-tagged cache), exactly as the cas-miss
  // branch above already guards the replicas>1 lose-update.
  await refreshStateCache(deps, scope.accountId, scope.profileId, symbol, nextState);
  return 'degraded';
};

/**
 * Strategy shape for the latch merge: `mergeConcurrent` is required here (the
 * caller only invokes this after narrowing on its presence), plus the
 * reconcile spine's `initialState` / migration surface for the winner re-read.
 */
export interface LatchMergeStrategy extends SymbolStateStrategyShape {
  mergeConcurrent(input: { readonly base: unknown; readonly latchSource: unknown }): unknown;
}

export interface MergeLatchDeps {
  readonly redis: Redis;
  readonly logger: Logger;
  readonly persistSymbolState: PersistSymbolState;
  readonly coldLoad: {
    loadSymbolState(scope: ProfileScope, symbol: string): Promise<SymbolStateRowView | null>;
  };
  readonly metrics?: MetricsSink;
}

/**
 * Recover a tick commit that CAS-missed: re-read the winner (fill) body, let the
 * strategy graft the tick's non-re-derivable latch fields onto it, and CAS-write
 * the merged body. Bounded retries — a fresh fill can win again between our
 * re-read and write, so re-read + re-merge each attempt (the merge composes on
 * the newest winner). Exhausting retries logs and gives up: the latch fields are
 * lost, same as the pre-#581 skip, but only after a real write storm.
 *
 * Returns `true` when a merged body landed. NEVER reached at single replica
 * (`chainByKey` means the tick commit never CAS-misses). Mirrors
 * {@link mutateSymbolState}'s optimistic loop; the mutate here is "graft
 * latches onto the winner" rather than a caller-supplied mutator.
 */
export const mergeLatchFieldsOnCasMiss = async (
  deps: MergeLatchDeps,
  scope: ProfileScope,
  symbol: string,
  strategy: LatchMergeStrategy,
  config: unknown,
  tickNextState: unknown,
): Promise<boolean> => {
  const accountId = scope.accountId as AccountId;
  const profileId = scope.profileId as ProfileId;
  const tags = { profileId: unwrapId(profileId), symbol };
  for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt += 1) {
    // Same independent-input read as mutateSymbolState: durable row and cached
    // body feed the reconcile with no dependency, so read them together.
    const [row, cachedBody] = await Promise.all([
      deps.coldLoad.loadSymbolState(scope, symbol),
      deps.redis.get(buildSymbolStateKey(accountId, profileId, symbol)),
    ]);
    const reconciled = await reconcileAndMigrate(
      deps,
      accountId,
      profileId,
      symbol,
      strategy,
      config,
      row,
      cachedBody,
    );
    if (reconciled === null) {
      // Migration failure on the winner re-read. The tick's orders already
      // placed (idempotent); the next tick re-runs against the migrated body.
      deps.logger.warn(
        tags,
        'latch-merge: winner re-read migration failed; latch fields not merged',
      );
      return false;
    }
    const merged = strategy.mergeConcurrent({
      base: reconciled.state,
      latchSource: tickNextState,
    });
    const landed = await writeStateThrough(
      deps,
      scope,
      symbol,
      merged,
      reconciled.workingVersion,
      reconciled.expectedVersion,
    );
    if (landed) {
      deps.metrics?.record('state_commit_latch_merged', 1, tags);
      deps.logger.info(tags, 'latch-merge: grafted tick latch fields onto concurrent winner');
      return true;
    }
  }
  deps.metrics?.record('state_commit_latch_merge_exhausted', 1, tags);
  deps.logger.warn(tags, 'latch-merge: CAS retries exhausted; tick latch fields dropped');
  return false;
};
