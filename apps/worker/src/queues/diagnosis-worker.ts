// The profile-diagnosis consumer: read the profile's world, walk the whole
// ladder, and publish each rung's outcome as it lands.
//
// Read-only throughout. An investigation that could change what it investigates
// is not evidence, so nothing here binds a symbol, pauses a profile, stamps a
// cooldown, or persists a snapshot.
//
// Progress is published from the worker's real position in the ladder, never
// interpolated. A rung the operator sees resolve has resolved; a rung shown
// running is running. That honesty is the whole point of the feature, so the
// per-rung write costs one UPDATE and is worth it.

import type { Logger } from 'pino';
import {
  asAccountId,
  asProfileId,
  asUserId,
  buildProfileDiagnosis,
  DIAGNOSIS_STEPS,
  DIAGNOSIS_STEP_LABELS,
  runDiagnosisStep,
  type DiagnosisStep,
  type DiagnosisStepId,
  type DiagnosisStepResult,
  type ProfileDiagnosisInput,
} from '@app/contracts';
import { createBinanceRest, type BinanceMode, type WeightGovernor } from '@app/binance';
import { profileRepo, repo as dbRepo, type Database } from '@app/db';
import type { Redis } from 'ioredis';
import type { StrategyRegistry } from '@app/strategy-core';
import type { AssetPolicy } from 'crons/discovery/asset-policy.js';
import type { SymbolAdmission } from 'crons/discovery/symbol-admission.js';
import { parseAccountPermissions } from 'lib/account-permissions.js';
import { buildAccountPermissionsKey } from 'executor/redis-namespace.js';
import type { QueueSet } from './queue-set.js';
import type { DiagnosisJobData } from './job-payloads.js';
import { gatherDiagnosisInput } from './diagnosis/gather.js';
import { probeLiveFunnel } from './diagnosis/live-funnel.js';

/** The rung that owns the live re-probe, and therefore all of the run's latency. */
const PROBE_STEP: DiagnosisStepId = 'candidate-funnel';

export interface DiagnosisWorkerDeps {
  readonly db: Database;
  readonly redis: Redis;
  readonly logger: Logger;
  readonly strategies: StrategyRegistry;
  /** Shared per-IP request-weight governor; the probe queues behind live trading. */
  readonly weightGovernor: WeightGovernor;
  /** The SAME asset-classification snapshot the discovery cron reads, so the probe's funnel cannot classify an asset the cron classified differently. */
  readonly getAssetPolicy: () => Promise<AssetPolicy>;
  /** The SAME mode-keyed admission snapshot the discovery cron reads. Shared so the probe cannot admit a symbol the cron cut, and so the probe stops re-sweeping the whole symbol-info keyspace the cron just swept. */
  readonly getSymbolAdmission: (mode: BinanceMode) => Promise<ReadonlyMap<string, SymbolAdmission>>;
  readonly nowMs: () => number;
}

/**
 * Render the ladder for the UI: resolved rungs carry their outcome, the rung
 * named by `running` is in flight, the rest are still pending.
 */
const renderSteps = (
  results: ReadonlyMap<DiagnosisStepId, DiagnosisStepResult>,
  running: DiagnosisStepId | null,
): DiagnosisStep[] =>
  DIAGNOSIS_STEPS.map((id) => {
    const label = DIAGNOSIS_STEP_LABELS[id];
    const r = results.get(id);
    if (r) return { id, label, status: r.status, line: r.line };
    return {
      id,
      label,
      status: id === running ? ('running' as const) : ('pending' as const),
      line: '',
    };
  });

/**
 * Register the diagnosis consumer.
 *
 * Study-role, deliberately: the operator asks "why isn't it trading?" precisely
 * when the live worker is wedged, and an investigation that cannot run in that
 * case answers the one question it exists for with silence. Under the default
 * single-process `ROLE=all` it runs alongside everything else either way.
 *
 * Idempotency is the durable run row, not the jobId: a retry that arrives after
 * a terminal write finds the row no longer live and returns.
 */
export function registerDiagnosisWorker(queueSet: QueueSet, deps: DiagnosisWorkerDeps): void {
  // Unsigned public client, matching the discovery cron: 24h tickers and klines
  // need no credentials, and the probe must read the same market the cron reads.
  const rest = createBinanceRest({
    mode: 'live',
    credentials: { apiKey: '', secretKey: '' },
    weightGovernor: deps.weightGovernor,
  });

  queueSet.registerWorker<DiagnosisJobData>('profile-diagnosis', async (job) => {
    const { runId, liveProbe } = job.data;
    const userId = asUserId(job.data.userId);
    const accountId = asAccountId(job.data.accountId);
    const profileId = asProfileId(job.data.profileId);

    // Pre-scope: a failure here is a transient DB problem with no proven scope,
    // so there is no row this job may write. Rethrow to the DLQ.
    const p = await profileRepo(deps.db, userId, accountId, profileId);

    const run = await p.diagnosisRuns.findById(runId);
    if (!run || (run.status !== 'queued' && run.status !== 'running')) {
      deps.logger.info({ runId, status: run?.status }, 'diagnosis: run not live; skipping');
      return;
    }

    // Frozen for the whole analysis, so every rung ages the same evidence against
    // the same instant. The terminal row stamps below deliberately re-read the
    // clock instead: `finishedAt` records when the run ENDED, and a live probe
    // puts seconds between the two.
    const nowMs = deps.nowMs();
    const endedAt = (): Date => new Date(deps.nowMs());
    const results = new Map<DiagnosisStepId, DiagnosisStepResult>();
    // Progress is presentational; the terminal `finish` write is the result. A
    // transient failure here must cost live detail, not the rungs already
    // resolved, so it is logged and swallowed rather than failing the run.
    const publish = (running: DiagnosisStepId | null): Promise<void> =>
      p.diagnosisRuns
        .patchSteps(runId, renderSteps(results, running))
        .catch((err: unknown) =>
          deps.logger.warn({ err, runId }, 'diagnosis: progress write failed; continuing'),
        );

    const mode = await dbRepo.accounts.binanceModeById(deps.db, accountId);
    if (mode === null) {
      await p.diagnosisRuns.fail(runId, 'This account no longer exists.', endedAt());
      return;
    }

    let gathered;
    try {
      gathered = await gatherDiagnosisInput({
        repo: p,
        redis: deps.redis,
        strategies: deps.strategies,
        logger: deps.logger,
        keyParts: { accountId, profileId },
        nowMs,
      });
    } catch (err) {
      // A fixed sentence, not `err.message`: the finished run is served by GETs
      // that stay open under LIVE_DEMO, and a driver error carries table names,
      // hosts and query fragments. The detail belongs in the log, which is
      // operator-only.
      await p.diagnosisRuns.fail(
        runId,
        'The investigation could not read this profile. Check the engine logs.',
        endedAt(),
      );
      deps.logger.warn({ runId, err }, 'diagnosis: could not gather input');
      return;
    }

    try {
      let input: ProfileDiagnosisInput = gathered.input;
      for (const id of DIAGNOSIS_STEPS) {
        if (id === PROBE_STEP) {
          // Show the slow rung as running BEFORE spending the request weight, so
          // the operator sees where the seconds go rather than watching a gap.
          await publish(id);
          const probed =
            liveProbe && gathered.discovery
              ? await probeLiveFunnel(
                  {
                    getAllTickers: () => rest.getAllTickers24hr(),
                    getKlines: (symbol, limit) => rest.getKlines({ symbol, interval: '1h', limit }),
                    mode,
                    symbolAdmission: () => deps.getSymbolAdmission(mode),
                    liveSymbolAdmission: () => deps.getSymbolAdmission('live'),
                    assetPolicy: deps.getAssetPolicy,
                    accountPermissions: async () =>
                      parseAccountPermissions(
                        await deps.redis.get(buildAccountPermissionsKey(accountId)),
                      ),
                    autoSymbols: gathered.discovery.autoSymbols,
                    manualSymbols: gathered.discovery.manualSymbols,
                    logger: deps.logger,
                    nowMs,
                  },
                  gathered.discovery.config,
                  gathered.discovery.quoteAsset,
                )
              : null;
          // A failed probe leaves `liveFunnel` unset, and the rung falls back to
          // the stored scan while SAYING it is a stored scan. Silently presenting
          // an old funnel as a live measurement is the one outcome to avoid.
          if (probed) input = { ...input, liveFunnel: probed };
        }
        results.set(
          id,
          runDiagnosisStep(id, input, (stepId, err) =>
            deps.logger.error({ runId, stepId, err }, 'diagnosis: rung threw; reported as unknown'),
          ),
        );
        await publish(null);
      }
      await p.diagnosisRuns.finish(runId, buildProfileDiagnosis(input, results), endedAt());
    } catch (err) {
      // Individual rungs already convert their own throws into `unknown`, so
      // reaching here means the run machinery itself broke. Mark the row so the
      // polling UI stops waiting, then rethrow to the DLQ.
      await p.diagnosisRuns
        .fail(runId, 'The investigation could not be completed.', endedAt())
        .catch((writeErr: unknown) =>
          deps.logger.error({ runId, err: writeErr }, 'diagnosis: could not mark run errored'),
        );
      throw err;
    }
  });
}
