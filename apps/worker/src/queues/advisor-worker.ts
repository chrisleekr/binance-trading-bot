import type { Logger } from 'pino';
import { z } from 'zod';
import {
  asAccountId,
  asProfileId,
  asUserId,
  BacktestParamsSchema,
  DEFAULT_ENABLEMENT_POLICY,
  EnablementPolicy,
  toConfigJsonSchema,
  type BacktestResult,
} from '@app/contracts';
import { profileRepo, type Database } from '@app/db';
import {
  AdvisorConfigStaleError,
  buildImproveInput,
  partitionSuggestions,
  runAdvisor,
  shapePriorRuns,
  type AdvisorPriorRuns,
  type ImproveConfigInput,
  type LlmAssist,
} from '@app/llm';
import type { StrategyRegistry } from '@app/strategy-core';
import type { QueueSet } from './queue-set.js';
import type { AdvisorJobData } from './job-payloads.js';

export interface AdvisorWorkerDeps {
  readonly db: Database;
  readonly logger: Logger;
  /**
   * Resolve the advisor client from the DB-stored provider config, per job. The
   * provider is operator-switchable at runtime, so the client is built fresh each
   * run. `available` is false when the selected provider has no usable config; the
   * handler then completes the row `error`/`not-configured` rather than calling a
   * client that would reject.
   */
  readonly resolveLlm: () => Promise<LlmAssist>;
  /** Shared plugin registry — resolves the run's strategy for schema + version. */
  readonly strategies: StrategyRegistry;
}

type ScopedRepo = Awaited<ReturnType<typeof profileRepo>>;

// Prior same-market runs for the advisor's history. The metric-key set, cap, and
// pure shaping now live in @app/llm's shapePriorRuns, shared with the api's thin
// wrapper so a server call and this background job reason over the identical
// context; only the DB read stays per-site to keep @app/llm DB-free. Same-market
// only (identical symbols + window + interval); the current run is excluded by its
// OWN stored signature so editing the config after the run cannot make it reappear
// inside its own history. Empty when the params do not parse (no reliable market key).
async function buildPriorRuns(
  p: ScopedRepo,
  strategyId: string,
  parsedParams: ReturnType<typeof BacktestParamsSchema.safeParse>,
  currentSignature: string | null,
): Promise<AdvisorPriorRuns> {
  if (!parsedParams.success) return { total: 0, sample: [] };
  const pp = parsedParams.data;
  const rows = await p.resultLedger.listForMarket({
    symbols: pp.symbols,
    window: { fromMs: pp.fromMs, toMs: pp.toMs, interval: pp.strategyInterval },
    strategyId,
  });
  return shapePriorRuns(rows, currentSignature);
}

interface AssembledInput {
  readonly baseConfig: Record<string, unknown>;
  readonly input: ImproveConfigInput;
  // The strategy's zod schema, used to re-validate each patched suggestion.
  readonly configSchema: z.ZodType;
}

/**
 * Assemble the advisor's read of a finished run locally: the DB/registry reads the
 * api's thin wrapper does, then the pure {@link buildImproveInput}. Returns null
 * when the run is missing, not `done`, has no result, its profile is gone, or its
 * strategy is unknown — all non-retryable, so the caller records `error` without
 * rethrowing. Propagates {@link AdvisorConfigStaleError} when the run's config no
 * longer matches the schema, which the caller also treats as terminal.
 */
async function assembleAdvisorInput(
  deps: AdvisorWorkerDeps,
  p: ScopedRepo,
  runId: string,
): Promise<AssembledInput | null> {
  const run = await p.backtestRuns.get(runId);
  if (!run || run.status !== 'done' || run.result === null) return null;
  const profile = await p.profile.findById();
  if (!profile) return null;
  const plugin = deps.strategies.get(profile.strategyName);
  if (!plugin) return null;

  const result = run.result as BacktestResult;
  const parsedParams = BacktestParamsSchema.safeParse(result.params);
  const priorRuns = await buildPriorRuns(
    p,
    profile.strategyName,
    parsedParams,
    run.backtestSignature,
  );
  const parsedPolicy = EnablementPolicy.safeParse(profile.enablementPolicy ?? {});
  const policy = parsedPolicy.success ? parsedPolicy.data : DEFAULT_ENABLEMENT_POLICY;
  // Serialise the zod config schema to the JSON-Schema doc the model reads,
  // through the shared helper so it matches the api descriptor and web panels.
  const configSchemaDoc = toConfigJsonSchema(plugin.configSchema);
  const { baseConfig, input } = buildImproveInput({
    strategyName: profile.strategyName,
    strategyVersion: profile.strategyVersion,
    configSchema: plugin.configSchema,
    configSchemaDoc,
    profileConfig: profile.config,
    result,
    priorRuns,
    policy,
  });
  return { baseConfig, input, configSchema: plugin.configSchema };
}

/**
 * Register the study-role `advisor` worker. The durable `backtest_advisor_result`
 * row is the source of truth: the api transitions it to `running` (single-flight),
 * this worker fulfils it and writes the terminal `done`/`error` state the polling
 * UI reads. Idempotency is the DB row, not a jobId — a retry after a terminal
 * write finds the row no longer `running` and noops, so the model is never
 * re-billed. On a model failure the row is `error`/`failed` and the job rethrows
 * so the queue-set diverts it to the DLQ (attempts:1 → immediate).
 */
export function registerAdvisorWorker(queueSet: QueueSet, deps: AdvisorWorkerDeps): void {
  queueSet.registerWorker<AdvisorJobData>('advisor', async (job) => {
    const { runId, variant } = job.data;
    const userId = asUserId(job.data.userId);
    const accountId = asAccountId(job.data.accountId);
    const profileId = asProfileId(job.data.profileId);

    // Pre-scope ownership lookup, like the backtest worker: a failure here
    // (transient DB blip) rethrows to the DLQ — there is no proven scope yet, so
    // no row to mark.
    const p = await profileRepo(deps.db, userId, accountId, profileId);

    const completeError = (errorReason: 'failed' | 'not-configured'): Promise<void> =>
      p.backtestAdvisorResults.completeVariant({
        runId,
        variant,
        status: 'error',
        summary: null,
        suggestions: [],
        dropped: [],
        errorReason,
      });

    // Idempotency guard is the DB row, not a jobId: only a slot THIS job claimed
    // (status `running`) is ours to fulfil. A row that was cancelled, finished, or
    // removed between enqueue and pickup (a regenerate raced, or the run was
    // deleted) is a noop — a retry after a terminal write must not re-run.
    const row = await p.backtestAdvisorResults.getVariant(runId, variant);
    if (!row || row.status !== 'running') {
      deps.logger.info({ runId, variant }, 'advisor slot not running; skipping');
      return;
    }

    // A queued job is never `manual` (that slot is written synchronously by the
    // api). Guard defensively: a stray manual job has no server generation path,
    // so record the failure rather than mis-call the model. Narrows `variant` to
    // an ImproveConfigMode for runAdvisor below.
    if (variant === 'manual') {
      await completeError('failed');
      deps.logger.warn({ runId }, 'advisor job had manual variant; no server path');
      return;
    }

    // Resolve the provider client from the live DB config for this job. The
    // provider can change between the api's `advisor:ready` check at enqueue and
    // this run; the ready flag prevents the common case, this handles the race.
    const llm = await deps.resolveLlm();
    if (!llm.available) {
      await completeError('not-configured');
      return;
    }

    let assembled: AssembledInput | null;
    try {
      assembled = await assembleAdvisorInput(deps, p, runId);
    } catch (err) {
      // A stale config is terminal (a re-drive changes nothing), so record the
      // error and return WITHOUT rethrowing. Any other assembly failure is
      // unexpected — rethrow to the DLQ.
      if (err instanceof AdvisorConfigStaleError) {
        await completeError('failed');
        deps.logger.warn({ runId, variant }, 'advisor: run config stale; cannot advise');
        return;
      }
      throw err;
    }
    if (!assembled) {
      // Run missing / not done / strategy unknown: nothing to retry.
      await completeError('failed');
      deps.logger.warn({ runId, variant }, 'advisor: run not available to advise on');
      return;
    }

    try {
      // `variant` is narrowed past `manual` above, so it is an ImproveConfigMode.
      const resp = await runAdvisor(llm, assembled.input, variant);
      const { valid, dropped } = partitionSuggestions(
        assembled.configSchema,
        assembled.baseConfig,
        resp.suggestions,
      );
      await p.backtestAdvisorResults.completeVariant({
        runId,
        variant,
        status: 'done',
        summary: resp.summary,
        suggestions: valid,
        dropped,
        errorReason: null,
      });
    } catch (err) {
      await completeError('failed').catch((writeErr: unknown) =>
        deps.logger.error(
          { runId, variant, err: writeErr },
          'advisor: could not mark row errored; stale-advisor sweep will reconcile',
        ),
      );
      deps.logger.warn({ runId, variant, err }, 'advisor generation failed');
      throw err; // surface to the queue-set failed handler → DLQ
    }
  });
}
