// Assemble everything the pure diagnosis ladder reads, from the stores that
// already hold it. Every read here is read-only by construction: an
// investigation must never be able to change the thing it is investigating.
//
// Each read is individually fail-soft. A rung that loses its input reports
// `unknown` and every other rung still runs — the opposite of the failure mode
// this feature exists to fix, where one missing signal made the whole picture
// unreadable.

import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import {
  DiscoveryConfigSchema,
  DISCOVERY_HEALTH_WINDOW,
  unwrapId,
  type AssetPolicyAbortRecord,
  type OpenCondition,
  type ProfileDiagnosis,
  type ProfileDiagnosisInput,
  type ReasonAttributionMap,
  type StoredDiscoveryConfig,
} from '@app/contracts';
import {
  PROFILE_SUBJECT,
  profileKey,
  projections,
  type ProfileKeyParts,
  type profileRepo,
} from '@app/db';
import type { StrategyRegistry } from '@app/strategy-core';
import { callAsync } from '../../lib/call-async.js';
import { readAssetPolicyAbortRecord } from '../../crons/discovery/abort-record.js';

type ScopedRepo = Awaited<ReturnType<typeof profileRepo>>;

// The heartbeat the worker writes; the api's health route reads the same bytes.
const WORKER_STATUS_KEY = 'worker:status';

/**
 * Newest scans to read. Wider than `DISCOVERY_HEALTH_WINDOW`, which is the span
 * the breadth verdict is judged over: the history strip wants enough points to
 * separate a chronic choke from an unlucky scan, and the verdict still reads
 * only its own window off the front of this list.
 */
const SNAPSHOT_LIMIT = 40;

/** Condition edges to read for the timeline. Bounded — this is a tail, not an export. */
const TIMELINE_LIMIT = 200;

export interface DiagnosisGatherDeps {
  readonly repo: ScopedRepo;
  readonly redis: Pick<Redis, 'get' | 'exists'>;
  readonly strategies: StrategyRegistry;
  readonly logger: Logger;
  /** Branded, so the halt-flag key is composed from the same parts the writer used. */
  readonly keyParts: ProfileKeyParts;
  readonly nowMs: number;
}

/**
 * Whether the LIVE trading process is reporting.
 *
 * PRESENCE is the signal, not the payload. `startWorkerHeartbeat` writes a fixed
 * `{sha, bootedAt}` string, rewritten unchanged on every refresh, so `bootedAt`
 * is when the process started — reading it as "last seen" would call a worker
 * that has been up for a week the deadest thing on the page. The key's TTL
 * outlives two refresh intervals, so expiry is the staleness mechanism: a key
 * that exists at all was written recently, and an absent key means the process
 * stopped writing. That is why the caller gets a boolean and not an age.
 */
const readHeartbeat = async (redis: Pick<Redis, 'get'>, logger: Logger): Promise<boolean> => {
  try {
    return (await redis.get(WORKER_STATUS_KEY)) !== null;
  } catch (err) {
    // Unreadable is not the same as absent, but both leave liveness unproven,
    // and claiming a live engine off a failed read is the one wrong answer.
    logger.warn({ err }, 'diagnosis: heartbeat read failed');
    return false;
  }
};

const readHalts = async (deps: DiagnosisGatherDeps): Promise<ProfileDiagnosisInput['halts']> => {
  try {
    const halted = (await deps.redis.exists(profileKey(deps.keyParts, 'entryHaltDaily'))) > 0;
    // No start time: the flag is a bare Redis key with a TTL to the next UTC
    // day. Reporting a guessed start would be worse than reporting none.
    return halted ? [{ label: "Today's loss limit was hit", sinceMs: null }] : [];
  } catch (err) {
    // null, not []: an empty list is the answer "nothing is halted", and a
    // failed read has not earned it. The two reads run concurrently over one
    // client, so this command can fail while the heartbeat GET succeeds, which
    // would leave `worker-alive` reporting a live engine and this rung quietly
    // clearing a halt it never saw.
    deps.logger.warn({ err }, 'diagnosis: halt flag read failed');
    return null;
  }
};

/**
 * The newest discovery cycle's refusal to rank, if one is parked.
 *
 * Delegated to the module that writes the record, so the format has exactly one reader. Fail-soft to `null` there, matching the heartbeat read: an unreadable or unparseable record leaves rung 5 to judge the profile on staleness alone, which is a weaker answer but a true one.
 *
 * @param deps - The gather's ports; the Redis client, the logger, and the key parts the discovery cron composed the same key from.
 * @returns The parked refusal with its cause and time, or null when none is recorded or the record could not be trusted.
 */
const readAssetPolicyAbort = (deps: DiagnosisGatherDeps): Promise<AssetPolicyAbortRecord | null> =>
  readAssetPolicyAbortRecord(deps.redis, deps.logger, unwrapId(deps.keyParts.profileId));

const toOpenConditions = (
  rows: readonly {
    condition: string;
    symbol: string;
    code: string;
    detail: unknown;
    since: Date;
  }[],
): readonly OpenCondition[] =>
  rows.map((r) => ({
    condition: r.condition,
    symbol: r.symbol,
    code: r.code,
    detail: r.detail,
    sinceMs: r.since.getTime(),
  }));

/** Condition edges, newest-first, in the shape the timeline renders. */
const toTimeline = (
  rows: readonly { time: Date; symbol: string | null; ctx: unknown }[],
): ProfileDiagnosis['timeline'] =>
  rows.map((r) => {
    const ctx = (r.ctx ?? {}) as {
      condition?: unknown;
      code?: unknown;
      previousCode?: unknown;
    };
    return {
      atMs: r.time.getTime(),
      condition: typeof ctx.condition === 'string' ? ctx.condition : 'unknown',
      code: typeof ctx.code === 'string' ? ctx.code : null,
      previousCode: typeof ctx.previousCode === 'string' ? ctx.previousCode : null,
      symbol: r.symbol,
    };
  });

export interface GatheredDiagnosis {
  readonly input: ProfileDiagnosisInput;
  /**
   * Everything the live re-probe needs, or null when the stored discovery config
   * does not parse — in which case there is nothing to re-derive the funnel from
   * and the `config-invalid` rung already owns the answer.
   */
  readonly discovery: {
    readonly config: StoredDiscoveryConfig;
    readonly quoteAsset: string;
    readonly autoSymbols: readonly string[];
    readonly manualSymbols: readonly string[];
  } | null;
}

/**
 * Read the profile's world into the pure ladder's input.
 *
 * Throws when the profile is gone, and also when any read the verdict RESTS ON
 * fails. That is deliberate and it is the opposite of fail-soft: degrading a
 * failed `listOpen` to `[]` would render as "nothing is blocking it", and a
 * failed symbol read would put the slot maths on a count that is not the count.
 * A run that errors is recoverable — the operator presses the button again —
 * whereas a confident wrong answer from a tool built to prove things is not.
 *
 * The timeline is the one exception, because it is a presentational tail: a
 * missing edge list costs history, not a verdict, and the open conditions still
 * carry every current span.
 */
export const gatherDiagnosisInput = async (
  deps: DiagnosisGatherDeps,
): Promise<GatheredDiagnosis> => {
  const profile = await deps.repo.profile.findById();
  if (!profile) throw new Error('diagnosis: profile no longer exists');

  const parsedDiscovery = DiscoveryConfigSchema.safeParse(
    (profile as { discoveryConfig?: unknown }).discoveryConfig ?? {},
  );
  const discoveryCfg = parsedDiscovery.success ? parsedDiscovery.data : null;
  if (!parsedDiscovery.success) {
    deps.logger.warn(
      { err: parsedDiscovery.error },
      'diagnosis: discovery config did not parse; discovery rungs report unknown',
    );
  }

  const [
    heartbeatPresent,
    halts,
    assetPolicyAbort,
    conditionRows,
    snapshotRows,
    symbolRows,
    edgeRows,
  ] = await Promise.all([
    readHeartbeat(deps.redis, deps.logger),
    readHalts(deps),
    readAssetPolicyAbort(deps),
    deps.repo.conditionStates.listOpen(),
    deps.repo.discoveryUniverseSnapshots.listForProfile(SNAPSHOT_LIMIT),
    deps.repo.profileSymbols.listForProfile(),
    // `callAsync`, not a bare call: a synchronous throw here is raised while this array literal is being built, before any promise exists for the `.catch` to attach to, so it would escape the one read that is meant to be survivable and fail the whole investigation.
    callAsync(() => deps.repo.actionLogs.listConditionEdges(TIMELINE_LIMIT)).catch(
      (err: unknown) => {
        deps.logger.warn({ err }, 'diagnosis: condition edge read failed; timeline omitted');
        return [];
      },
    ),
  ]);

  const plugin = deps.strategies.get(profile.strategyName);
  // An unknown strategy leaves every lever unattributable. That degrades the
  // report to "here is what is blocking you" without "here is the setting",
  // which is still worth reading — inventing paths would not be.
  const reasonAttribution = (plugin?.reasonAttribution ?? {}) as ReasonAttributionMap;

  const autoSymbols = symbolRows.filter((s) => s.source === 'auto').map((s) => s.symbol);
  const manualSymbols = symbolRows.filter((s) => s.source === 'manual').map((s) => s.symbol);

  // Only what the profile currently holds. A condition row closes when its
  // owning tick writes a null code, so a row for a symbol whose binding is gone
  // has no writer left and stays open forever. Reporting it names a coin the
  // operator does not own as the reason they are not trading. Filtered ONCE,
  // here, so every rung and every count downstream reads the same set. The bound
  // list is already loaded above, so this costs no query. Profile-level rows are
  // not about a symbol at all and are exempt.
  const boundSymbols = new Set(symbolRows.map((s) => s.symbol));
  const ownedConditionRows = conditionRows.filter(
    (r) => r.symbol === PROFILE_SUBJECT || boundSymbols.has(r.symbol),
  );

  const quoteAsset = profile.quoteAsset.toUpperCase();

  const input: ProfileDiagnosisInput = {
    nowMs: deps.nowMs,
    profile: {
      enabled: profile.enabled,
      quoteAsset,
      config: (profile.config ?? {}) as Record<string, unknown>,
      // `null`, not `false`, when the config did not parse: the rungs report
      // unreadable as unknown rather than as a deliberate switch-off.
      discoveryEnabled: discoveryCfg === null ? null : discoveryCfg.enabled,
      discoveryConfig: discoveryCfg,
      maxAutoSymbols: discoveryCfg?.maxAutoSymbols ?? null,
      refreshPeriodMs: discoveryCfg?.refreshPeriodMs ?? null,
      autoSymbolCount: autoSymbols.length,
    },
    worker: { heartbeatPresent },
    halts,
    assetPolicyAbort,
    conditions: toOpenConditions(ownedConditionRows),
    snapshots: projections.toDiagnosisSnapshots(snapshotRows),
    reasonAttribution,
    discoveryHealthWindow: DISCOVERY_HEALTH_WINDOW,
    timeline: toTimeline(edgeRows),
  };

  return {
    input,
    discovery: discoveryCfg
      ? { config: discoveryCfg, quoteAsset, autoSymbols, manualSymbols }
      : null,
  };
};
