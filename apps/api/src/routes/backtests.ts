import {
  AdvisorListResponse,
  AdvisorResultSchema,
  asProfileId,
  BACKTEST_LIST_DEFAULT_PAGE_SIZE,
  BacktestCreatedSchema,
  BacktestListResponse,
  BacktestParamsSchema,
  BacktestProgressDetailSchema,
  BacktestRunDetailSchema,
  BacktestRunListFilter,
  coerceImproveConfigModelShape,
  DEFAULT_ENABLEMENT_POLICY,
  EnablementPolicy,
  ErrorEnvelope,
  ImproveConfigManualRequestSchema,
  ImproveConfigMode,
  ImproveConfigPromptResponseSchema,
  parseImproveConfigModelOutput,
  type AdvisorResult,
  type BacktestParams,
  type BacktestResult,
  type BacktestStatus,
} from '@app/contracts';
import type { BacktestRunRow } from '@app/db';
import { compositeCursor, splitCompositeCursor } from 'lib/cursor.js';
import {
  AdvisorConfigStaleError,
  buildImproveConfigManualPrompt,
  buildImproveInput,
  downsample,
  partitionSuggestions,
  shapePriorRuns,
  type AdvisorPriorRuns,
  type ImproveConfigInput,
} from '@app/llm';
import { mergeConfig } from '@app/strategy-core';
import { createRoute, z } from '@hono/zod-openapi';
import type { DI } from 'di.js';
import { assertOrderFeasibleForProfile, withDiagnostics } from 'lib/order-feasibility.js';
import { HttpError } from 'middleware/error.js';
import { requireUser } from 'middleware/require-user.js';
import { signatureForRun } from 'backtest-signature.js';
import { requireOwnedProfile, scopeOf } from 'route-helpers.js';
import { createApiHono, type ApiHono } from 'types.js';

/** Map a run row to the GET/abort detail response (status + embedded result). */
const toRunDetail = (run: BacktestRunRow): z.infer<typeof BacktestRunDetailSchema> => ({
  runId: run.id,
  profileId: run.profileId,
  status: run.status as BacktestStatus,
  progress: run.progress,
  // Validate the opaque jsonb at the response boundary; a malformed/legacy value
  // degrades to null rather than 500-ing or shipping an off-contract shape.
  progressDetail: BacktestProgressDetailSchema.safeParse(run.progressDetail).data ?? null,
  error: run.error,
  parentRunId: run.parentRunId,
  createdAt: run.createdAt.toISOString(),
  startedAt: run.startedAt?.toISOString() ?? null,
  finishedAt: run.finishedAt?.toISOString() ?? null,
  // Launch params, validated at creation, so the UI can seed Configure from a
  // run whose `result` is still null (queued/running).
  params: run.params as BacktestParams,
  result: capResultCurves((run.result as BacktestResult | null) ?? null),
});

// Map a raw advisor row to the wire `AdvisorResult`. jsonb columns are null
// until the row reaches `done`, so both suggestion arrays default to empty;
// `variant`/`status`/`errorReason` are stored as text but constrained to the
// contract enums by the table's check constraints, so the cast is safe here.
const toAdvisorResult = (row: AdvisorResultRow): AdvisorResult => ({
  id: row.id,
  variant: row.variant as AdvisorResult['variant'],
  status: row.status as AdvisorResult['status'],
  summary: row.summary,
  suggestions: (row.suggestions as AdvisorResult['suggestions'] | null) ?? [],
  dropped: (row.dropped as AdvisorResult['dropped'] | null) ?? [],
  errorReason: (row.errorReason as AdvisorResult['errorReason'] | null) ?? null,
  updatedAt: row.updatedAt.toISOString(),
});

const ProfileIdParam = z.object({ profileId: z.uuid() });
const RunParam = z.object({ profileId: z.uuid(), runId: z.uuid() });
// The variant path segment on the start route. `ImproveConfigMode` is the five
// generation variants only; the `manual` slot is written by the manual route,
// so an attempt to start `manual` (or an unknown value) fails validation → 422.
const RunVariantParam = z.object({
  profileId: z.uuid(),
  runId: z.uuid(),
  variant: ImproveConfigMode,
});

type OwnedProfile = Awaited<ReturnType<typeof requireOwnedProfile>>['profile'];
type ScopedRepo = Awaited<ReturnType<typeof requireOwnedProfile>>['p'];
type StrategyPlugin = NonNullable<ReturnType<DI['strategies']['get']>>;
// The raw advisor row, derived from the scoped repo's return type rather than
// imported: @app/db does not re-export `BacktestAdvisorResultRow` from its
// barrel (only the schema sub-barrel does), and packages/db is out of scope here.
type AdvisorResultRow = Awaited<
  ReturnType<ScopedRepo['backtestAdvisorResults']['listForRun']>
>[number];

// The equity/drawdown curves carry one point per tick — a 1m-interval run over a
// long window is hundreds of thousands to millions of points. Shipping them raw
// blows up the payload, the client's parse, and the chart's buffers, which OOM-
// kills a mobile tab (the "loads then crashes/reloads" symptom). A line chart
// cannot resolve more than ~1k points on any screen, and every headline metric
// (max drawdown, its window, CAGR) is computed server-side on the FULL curve and
// shipped in `metrics`, so downsampling only what the chart draws is lossless for
// the reader. Applied to every run-detail response, so it also fixes results
// already stored at full resolution — no migration.
const CHART_SAMPLE = 1000;

const capResultCurves = (result: BacktestResult | null): BacktestResult | null =>
  result === null
    ? null
    : {
        ...result,
        equityCurve: downsample(result.equityCurve, CHART_SAMPLE),
        drawdownSeries: downsample(result.drawdownSeries, CHART_SAMPLE),
      };

// Fetch what the advisor reads from a finished run — the strategy plugin (for
// re-validation), prior same-market history, and the enablement policy — then
// hand the plain data to the pure `buildImproveInput` in @app/llm. The
// DB/registry reads live here so the advisor composition stays pure and DB-free.
// Throws 409 if the run has no result yet, 404 if its strategy is unknown. Does
// NOT gate on the AI provider being configured — the manual paths build the
// prompt / validate a reply with no server-side provider.
const assembleAdvisorInput = async (
  di: DI,
  p: ScopedRepo,
  profile: OwnedProfile,
  run: BacktestRunRow,
): Promise<{
  plugin: StrategyPlugin;
  baseConfig: Record<string, unknown>;
  input: ImproveConfigInput;
}> => {
  if (run.status !== 'done' || run.result === null) {
    throw new HttpError('CONFLICT', 'run has no result to advise on yet');
  }
  const plugin = di.strategies.get(profile.strategyName);
  const descriptor = di.strategies.describeAll().find((d) => d.name === profile.strategyName);
  if (!plugin || !descriptor) throw new HttpError('NOT_FOUND', 'strategy');
  const result = run.result as BacktestResult;
  const parsedParams = BacktestParamsSchema.safeParse(result.params);
  // Prior configs tried on the SAME market (same symbols + window + interval,
  // varying config) and how they scored, newest first — what turns the advisor
  // from a stateless one-shot into something that reasons over the response
  // surface. Same-market only; the current run is excluded by its own stored
  // signature. Empty when params do not parse (no reliable market key) or nothing
  // else has run here yet.
  const priorRuns = await buildPriorRuns(
    p,
    profile.strategyName,
    parsedParams,
    run.backtestSignature,
  );
  // The profile's enablement policy: the gate thresholds this run's checklist is
  // scored against, fed to the advisor so it aims at the bars that decide go-live.
  const parsedPolicy = EnablementPolicy.safeParse(profile.enablementPolicy ?? {});
  const policy = parsedPolicy.success ? parsedPolicy.data : DEFAULT_ENABLEMENT_POLICY;
  try {
    const { baseConfig, input } = buildImproveInput({
      strategyName: profile.strategyName,
      strategyVersion: profile.strategyVersion,
      configSchema: plugin.configSchema,
      configSchemaDoc: descriptor.configSchema,
      profileConfig: profile.config,
      result,
      priorRuns,
      policy,
    });
    return { plugin, baseConfig, input };
  } catch (err) {
    // A config that no longer parses against the current schema cannot be rebuilt;
    // surface it as the same 409 the operator saw before.
    if (err instanceof AdvisorConfigStaleError) throw new HttpError('CONFLICT', err.message);
    throw err;
  }
};

// Prior same-market runs for the advisor's history. Fetch the same-market ledger
// rows here (the DB read) then hand them to the pure `shapePriorRuns` in @app/llm,
// which excludes the current run by its OWN stored signature (`run.backtestSignature`,
// stamped at completion, not recomputed from the live profile config, so editing
// the config after the run cannot make it reappear inside its own history), caps at
// the newest HISTORY_CAP, and reports the full count as `total`. Returns an empty
// history when the run's params do not parse: without a reliable (symbols, window,
// interval) key there is no comparable set to pull.
const buildPriorRuns = async (
  p: ScopedRepo,
  strategyId: string,
  parsedParams: ReturnType<typeof BacktestParamsSchema.safeParse>,
  currentSignature: string | null,
): Promise<AdvisorPriorRuns> => {
  if (!parsedParams.success) return { total: 0, sample: [] };
  const pp = parsedParams.data;
  const rows = await p.resultLedger.listForMarket({
    symbols: pp.symbols,
    window: { fromMs: pp.fromMs, toMs: pp.toMs, interval: pp.strategyInterval },
    strategyId,
  });
  return shapePriorRuns(rows, currentSignature);
};

// Pull the JSON object out of a model reply pasted from claude.ai. Takes the span
// from the first `{` to the last `}` and parses it; this assumes the reply holds
// exactly one JSON object (true for a claude.ai paste, even wrapped in prose or a
// ```json fence). Returns null when there is no parseable object (→ 422), so a
// reply with stray braces around two objects fails safe rather than mis-parsing.
const extractJsonObject = (raw: string): unknown | null => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
};

/** Delimiter of the token this reader emits. Two characters, so it cannot occur inside either half. */
const CURSOR_SEPARATOR = '__';

// Past-runs list query: composite cursor in the `<createdAt-iso>__<id>` wire
// format the handler also emits. The page default
// is the shared contract constant — the mobile-first runs table's default
// rows-per-page — so the web client can omit `limit` for the common case and
// keep the canonical URL param-free without the two defaults drifting.
const BacktestListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(BACKTEST_LIST_DEFAULT_PAGE_SIZE),
  // Both halves are gated here rather than in the handler: an unbindable timestamp or a non-uuid id reaches Postgres as an uncastable literal and surfaces as a 500 on a route whose only declared failure is 422. A bare-iso cursor stays accepted — its missing id lets a same-timestamp group surface in full on the next page rather than dropping rows.
  cursor: compositeCursor({ separator: CURSOR_SEPARATOR, allowBareTimestamp: true }).optional(),
  // Optional runs-table outcome filter (profit/loss/error); absent = every run.
  filter: BacktestRunListFilter.optional(),
});

const createRouteDef = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/backtests',
  tags: ['backtests'],
  request: {
    params: ProfileIdParam,
    body: { content: { 'application/json': { schema: BacktestParamsSchema } } },
  },
  responses: {
    202: {
      description: 'queued',
      content: { 'application/json': { schema: BacktestCreatedSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const getRouteDef = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/backtests/{runId}',
  tags: ['backtests'],
  request: { params: RunParam },
  responses: {
    200: {
      description: 'run detail',
      content: { 'application/json': { schema: BacktestRunDetailSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const listRouteDef = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/backtests',
  tags: ['backtests'],
  request: { params: ProfileIdParam, query: BacktestListQuery },
  responses: {
    200: {
      description: 'paginated runs newest first',
      content: { 'application/json': { schema: BacktestListResponse } },
    },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

const abortRouteDef = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/backtests/{runId}/abort',
  tags: ['backtests'],
  request: { params: RunParam },
  responses: {
    200: {
      description: 'run after abort',
      content: { 'application/json': { schema: BacktestRunDetailSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const retryRouteDef = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/backtests/{runId}/retry',
  tags: ['backtests'],
  request: { params: RunParam },
  responses: {
    202: {
      description: 'queued',
      content: { 'application/json': { schema: BacktestCreatedSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONFLICT', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const deleteRouteDef = createRoute({
  method: 'delete',
  path: '/profiles/{profileId}/backtests/{runId}',
  tags: ['backtests'],
  request: { params: RunParam },
  responses: {
    204: { description: 'deleted' },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONFLICT', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

// Advisor variant as a query param (e.g. `?mode=aggressive`) on the manual-prompt
// route, so it serves both the honest default and an opt-in EXPLORE lens without a
// body. `.catch('safe')` (not `.default`) so an absent OR unrecognised value both
// fall back to safe rather than 400ing.
//
// The `.openapi()` metadata is load-bearing, not decoration: a `ZodCatch` is opaque
// to the OpenAPI generator ("Unknown zod object type"), and one undocumentable
// schema takes the WHOLE document down — `/api/docs` and `/openapi.json` 500 for
// every route, not just this one. Declaring the wire shape here keeps the catch's
// leniency and the document.
const ImproveModeQuery = z.object({
  mode: ImproveConfigMode.catch('safe').openapi({
    type: 'string',
    enum: [...ImproveConfigMode.options],
    default: 'safe',
  }),
});

// List every persisted advisor variant for a run. Pure DB read — the UI
// rehydrates saved suggestions from here without any (re-billed) model call.
const advisorListRouteDef = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/backtests/{runId}/advisor',
  tags: ['backtests'],
  request: { params: RunParam },
  responses: {
    200: {
      description: 'saved advisor variants',
      content: { 'application/json': { schema: AdvisorListResponse } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

// Start (or regenerate) background generation for one variant. Claims the DB row
// via a conditional upsert to `running`, then enqueues a worker job IFF the claim
// transitioned the slot — the row is the single-flight guard. 202 with the current
// (running) row; 503 when no study worker/credential is live.
const advisorStartRouteDef = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/backtests/{runId}/advisor/{variant}',
  tags: ['backtests'],
  request: { params: RunVariantParam },
  responses: {
    202: {
      description: 'variant queued (running)',
      content: { 'application/json': { schema: AdvisorResultSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONFLICT', content: { 'application/json': { schema: ErrorEnvelope } } },
    503: { description: 'UNAVAILABLE', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

// Manual-loop routes, for an operator who has configured no server-side AI
// provider (see Settings) or who prefers to run it in claude.ai. `prompt`
// returns the exact prompt to copy in; `manual`
// validates the JSON reply pasted back and persists it to the `manual` slot.
// Neither needs a credential, so no 503.
const advisorPromptRouteDef = createRoute({
  method: 'get',
  path: '/profiles/{profileId}/backtests/{runId}/advisor/manual/prompt',
  tags: ['backtests'],
  request: { params: RunParam, query: ImproveModeQuery },
  responses: {
    200: {
      description: 'advisor prompt for manual use',
      content: { 'application/json': { schema: ImproveConfigPromptResponseSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONFLICT', content: { 'application/json': { schema: ErrorEnvelope } } },
  },
});

const advisorManualRouteDef = createRoute({
  method: 'post',
  path: '/profiles/{profileId}/backtests/{runId}/advisor/manual',
  tags: ['backtests'],
  request: {
    params: RunParam,
    body: { content: { 'application/json': { schema: ImproveConfigManualRequestSchema } } },
  },
  responses: {
    200: {
      description: 'persisted manual advisor result',
      content: { 'application/json': { schema: AdvisorResultSchema } },
    },
    404: { description: 'NOT_FOUND', content: { 'application/json': { schema: ErrorEnvelope } } },
    409: { description: 'CONFLICT', content: { 'application/json': { schema: ErrorEnvelope } } },
    422: {
      description: 'VALIDATION_FAILED',
      content: { 'application/json': { schema: ErrorEnvelope } },
    },
  },
});

export const backtestsRouter = (di: DI): ApiHono => {
  const app = createApiHono();
  app.use('/profiles/*/backtests', requireUser());
  app.use('/profiles/*/backtests/*', requireUser());

  app.openapi(createRouteDef, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const params = c.req.valid('json');
    // requireOwnedProfile (not scopeOf): the dedup signature is derived from the
    // profile's own config merged with the run override, so the handler needs the
    // profile row, not just the scope.
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const { operatorId, accountId } = p.scope;

    // `?force` (query-only, outside BacktestParams so it can never perturb the
    // backtestSignature) is the "Run fresh anyway" choice from the dedup dialog:
    // skip the dedup short-circuit and always create + enqueue a new run. A bare
    // `?force` (empty value) counts; only an explicit `?force=false` opts out.
    const forceParam = c.req.query('force');
    const force = forceParam !== undefined && forceParam !== 'false';

    // Same completion-signature seam the worker stamps on a finished run, so a
    // manual re-run recognises an identical completed run. Null when the
    // strategy is unknown or the config no longer parses → fall back to a normal
    // run (no dedup, no stamp).
    const sig = signatureForRun(
      di.strategies,
      profile.strategyName,
      profile.config,
      params.strategyConfigOverride ?? null,
      params,
    );
    if (sig && !force) {
      const existing = await p.backtestRuns.findDoneBySignature(sig.signature);
      if (existing) {
        c.set('auditEvent', {
          event: 'run-backtest',
          payload: { profileId, runId: existing.id, deduped: true },
        });
        return c.json({ runId: existing.id, deduped: true }, 202);
      }
    }

    // Refuse a manual run whose config cannot place a valid order or fund its
    // grid from the STARTING balance on a target symbol — a run where most buys
    // never place wastes the whole backfill + replay. Funds against the run's
    // `initialQuoteBalance` (exact); the per-order minimums use the current price
    // (the window series isn't backfilled yet). Only this operator create
    // endpoint gates feasibility before enqueuing a run.
    // Gated against PRODUCTION filters regardless of the account's environment,
    // because that is what the run itself uses: the engine replays production
    // klines and reads its filters through `getSymbolInfo`, which resolves the
    // live keyspace. Sizing the gate off testnet filters would refuse runs the
    // engine would have executed, and admit ones it would not.
    const saveDiagnostics = await assertOrderFeasibleForProfile(
      di,
      p,
      profile,
      mergeConfig(profile.config, params.strategyConfigOverride ?? {}),
      'live',
      { symbols: params.symbols, availableQuoteOverride: params.initialQuoteBalance },
    );

    // Validate the lineage pointer against ownership before persisting it: a
    // parent that is not an owned run of this profile (cross-account, or simply
    // gone) is dropped to null rather than stamped. The FK accepts any existing
    // id, so the account boundary is enforced here, not by the constraint.
    const parentRunId =
      params.parentRunId && (await p.backtestRuns.get(params.parentRunId))
        ? params.parentRunId
        : null;

    const run = await p.backtestRuns.create({
      symbols: params.symbols,
      params,
      parentRunId,
    });
    // jobId coalesces a duplicate submit of the same run; must match the
    // worker's backtestJobId(runId) = `backtest:<runId>`.
    try {
      await di.backtestQueue.add(
        'backtest',
        { runId: run.id, userId: operatorId, accountId, profileId },
        { jobId: `backtest:${run.id}` },
      );
    } catch (err) {
      // The row is already `queued`; if enqueue fails (e.g. Redis blip) it would
      // never run and would linger as a phantom in-flight row. Mark it errored so
      // it clears, then surface the failure (→ 500).
      await p.backtestRuns.fail(run.id, 'failed to enqueue backtest job');
      throw err;
    }
    c.set('auditEvent', { event: 'run-backtest', payload: { profileId, runId: run.id } });
    return c.json(withDiagnostics({ runId: run.id, deduped: false }, saveDiagnostics), 202);
  });

  app.openapi(getRouteDef, async (c) => {
    const { profileId: rawProfileId, runId } = c.req.valid('param');
    const profileId = asProfileId(rawProfileId);
    const p = await scopeOf(c, di, profileId);
    const run = await p.backtestRuns.get(runId);
    if (!run) throw new HttpError('NOT_FOUND', 'backtest-run');
    return c.json(toRunDetail(run), 200);
  });

  // Abort a queued/running run on demand. Marks it `cancelled` (the worker's
  // mid-run status poll then stops a live job cleanly via BacktestCancelledError;
  // a dead job has nothing to stop). Idempotent: a run already terminal is left
  // as-is and its current detail is returned. Frees the in-flight slot so a new
  // run can start, and lets the operator clear a hung run without waiting for the
  // periodic sweep.
  app.openapi(abortRouteDef, async (c) => {
    const { profileId: rawProfileId, runId } = c.req.valid('param');
    const profileId = asProfileId(rawProfileId);
    const p = await scopeOf(c, di, profileId);
    const run = await p.backtestRuns.get(runId);
    if (!run) throw new HttpError('NOT_FOUND', 'backtest-run');
    await p.backtestRuns.markCancelled(runId);
    const after = await p.backtestRuns.get(runId);
    if (!after) throw new HttpError('NOT_FOUND', 'backtest-run');
    c.set('auditEvent', { event: 'abort-backtest', payload: { profileId, runId } });
    return c.json(toRunDetail(after), 200);
  });

  // Retry a finished-but-not-done run: re-run its exact stored config as a fresh
  // run (new id), so the original stays as the historical error/cancelled record.
  // The stored `params` are the original request, present even when the run never
  // produced a result, so retrying a failed run needs no client round-trip.
  app.openapi(retryRouteDef, async (c) => {
    const { profileId: rawProfileId, runId } = c.req.valid('param');
    const profileId = asProfileId(rawProfileId);
    const p = await scopeOf(c, di, profileId);
    const { operatorId, accountId } = p.scope;

    const run = await p.backtestRuns.get(runId);
    if (!run) throw new HttpError('NOT_FOUND', 'backtest-run');
    if (run.status === 'queued' || run.status === 'running') {
      throw new HttpError('CONFLICT', 'cannot retry an in-flight run; abort it first');
    }

    const retried = await p.backtestRuns.create({ symbols: run.symbols, params: run.params });
    try {
      await di.backtestQueue.add(
        'backtest',
        { runId: retried.id, userId: operatorId, accountId, profileId },
        { jobId: `backtest:${retried.id}` },
      );
    } catch (err) {
      await p.backtestRuns.fail(retried.id, 'failed to enqueue backtest job');
      throw err;
    }
    c.set('auditEvent', {
      event: 'retry-backtest',
      payload: { profileId, runId: retried.id, retriedFrom: runId },
    });
    // A retry is always a fresh run, never a dedup hit.
    return c.json({ runId: retried.id, deduped: false }, 202);
  });

  // Delete a finished run from the history. Refused (409) when the run is still
  // the profile's pinned enablement baseline (un-pin first — the FK would
  // silently null the pin and drop the live gate), or still in-flight (the
  // repo's terminal-status guard returns false; abort it first). The profile row
  // is read for the baseline check, so requireOwnedProfile over scopeOf.
  app.openapi(deleteRouteDef, async (c) => {
    const { profileId: rawProfileId, runId } = c.req.valid('param');
    const profileId = asProfileId(rawProfileId);
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const run = await p.backtestRuns.get(runId);
    if (!run) throw new HttpError('NOT_FOUND', 'backtest-run');
    if (profile.baselineBacktestRunId === runId) {
      throw new HttpError(
        'CONFLICT',
        'this run is the profile baseline; un-pin it before deleting',
      );
    }
    if (!(await p.backtestRuns.deleteById(runId))) {
      throw new HttpError('CONFLICT', 'cannot delete an in-flight run; abort it first');
    }
    c.set('auditEvent', { event: 'delete-backtest', payload: { profileId, runId } });
    return new Response(null, { status: 204 });
  });

  // Rehydrate every saved advisor variant for a run. Durable per-(profile, run,
  // variant) rows, so this survives reload/tab-close and never calls the model —
  // the UI polls it while a variant is `running` and reads the terminal state.
  app.openapi(advisorListRouteDef, async (c) => {
    const { profileId: rawProfileId, runId } = c.req.valid('param');
    const profileId = asProfileId(rawProfileId);
    const p = await scopeOf(c, di, profileId);
    const run = await p.backtestRuns.get(runId);
    if (!run) throw new HttpError('NOT_FOUND', 'backtest-run');
    const rows = await p.backtestAdvisorResults.listForRun(runId);
    return c.json({ results: rows.map(toAdvisorResult) }, 200);
  });

  // Render the exact advisor prompt for manual use. No API key needed: the
  // operator copies this into claude.ai, where a Pro/Max subscription works.
  app.openapi(advisorPromptRouteDef, async (c) => {
    const { profileId: rawProfileId, runId } = c.req.valid('param');
    const profileId = asProfileId(rawProfileId);
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const run = await p.backtestRuns.get(runId);
    if (!run) throw new HttpError('NOT_FOUND', 'backtest-run');
    const { mode } = c.req.valid('query');
    const { input } = await assembleAdvisorInput(di, p, profile, run);
    return c.json({ prompt: buildImproveConfigManualPrompt(input, mode) }, 200);
  });

  // Validate the model reply the operator pasted back from claude.ai and persist
  // it to the `manual` slot: extract the JSON (422 if absent/garbled), check the
  // shape, partition the suggestions (schema-valid offered, invalid returned under
  // `dropped` with a reason), then upsert the durable `manual` row. Distinct slot,
  // so it never clobbers a server-generated `safe` (or other) variant.
  app.openapi(advisorManualRouteDef, async (c) => {
    const { profileId: rawProfileId, runId } = c.req.valid('param');
    const profileId = asProfileId(rawProfileId);
    const { reply } = c.req.valid('json');
    const { p, profile } = await requireOwnedProfile(c, di, profileId);
    const run = await p.backtestRuns.get(runId);
    if (!run) throw new HttpError('NOT_FOUND', 'backtest-run');
    const { plugin, baseConfig } = await assembleAdvisorInput(di, p, profile, run);
    const parsed = extractJsonObject(reply);
    if (parsed === null) {
      throw new HttpError('VALIDATION_FAILED', "could not find JSON in Claude's reply");
    }
    // Top-level shape guard for the manual paste: a reply with no recoverable
    // `suggestions` array is a wrong paste, and the operator deserves that told
    // (422) rather than a silent empty result. Per-item malformation is still
    // tolerated below. `coerce` first so a suggestions array serialized as a
    // string still counts as the right shape.
    const shaped = coerceImproveConfigModelShape(parsed);
    if (
      shaped === null ||
      typeof shaped !== 'object' ||
      !Array.isArray((shaped as Record<string, unknown>)['suggestions'])
    ) {
      throw new HttpError('VALIDATION_FAILED', "Claude's reply did not match the expected shape");
    }
    // Lenient per-item parse: keep the well-formed suggestions, dropping any
    // malformed one instead of rejecting the whole paste — the same tolerance
    // the server tool-call path uses.
    const advice = parseImproveConfigModelOutput(parsed);
    // `dropped` is always recomputed here from the strategy schema; any `dropped`
    // the pasted reply happened to carry is untrusted and deliberately ignored.
    const { valid, dropped } = partitionSuggestions(
      plugin.configSchema,
      baseConfig,
      advice.suggestions,
    );
    await p.backtestAdvisorResults.upsertManual({
      runId,
      summary: advice.summary,
      suggestions: valid,
      dropped,
    });
    c.set('auditEvent', { event: 'improve-backtest-config-manual', payload: { profileId, runId } });
    const row = await p.backtestAdvisorResults.getVariant(runId, 'manual');
    if (!row) throw new HttpError('NOT_FOUND', 'advisor-result');
    return c.json(toAdvisorResult(row), 200);
  });

  // Start (or regenerate) background generation for one variant. The heavy model
  // call runs in the worker's study role; here we only claim the slot and enqueue.
  // Registered AFTER the static `advisor/manual[/prompt]` routes so those win the
  // match: `{variant}` would otherwise capture `manual` and 422 on the enum.
  app.openapi(advisorStartRouteDef, async (c) => {
    const { profileId: rawProfileId, runId, variant } = c.req.valid('param');
    const profileId = asProfileId(rawProfileId);
    const p = await scopeOf(c, di, profileId);
    const { operatorId, accountId } = p.scope;
    const run = await p.backtestRuns.get(runId);
    if (!run) throw new HttpError('NOT_FOUND', 'backtest-run');
    // Advising is only meaningful on a finished run with a result; fail fast
    // before touching the queue.
    if (run.status !== 'done' || run.result === null) {
      throw new HttpError('CONFLICT', 'run has no result to advise on yet');
    }
    // The worker's study role publishes `advisor:ready` while a role instance with
    // a live Anthropic credential is up. Absent → no one would ever drain the job,
    // so refuse now rather than leave a row stuck `running` until the stale sweep.
    const ready = await di.redis.raw().get('advisor:ready');
    if (!ready) {
      throw new HttpError(
        'SERVICE_UNAVAILABLE',
        'AI advisor unavailable — study worker offline or no AI provider configured.',
      );
    }
    // Conditional upsert to `running` is the single-flight guard: true only when
    // this call brand-new-inserted or transitioned a done/error row, so a variant
    // already in flight never spawns a duplicate job.
    const started = await p.backtestAdvisorResults.transitionToRunning({ runId, variant });
    if (started) {
      try {
        // No jobId: a stable jobId + retained completed job would silently no-op a
        // regenerate re-add. The DB row above is the only single-flight guard.
        await di.advisorQueue.add('advisor', {
          runId,
          userId: operatorId,
          accountId,
          profileId,
          variant,
        });
      } catch (err) {
        // Row is `running` but nothing will drain it; free the slot so a retry can
        // re-claim, then surface the failure (→ 500).
        await p.backtestAdvisorResults.completeVariant({
          runId,
          variant,
          status: 'error',
          summary: null,
          suggestions: [],
          dropped: [],
          errorReason: 'failed',
        });
        throw err;
      }
    }
    c.set('auditEvent', {
      event: 'start-backtest-advisor',
      payload: { profileId, runId, variant },
    });
    const row = await p.backtestAdvisorResults.getVariant(runId, variant);
    if (!row) throw new HttpError('NOT_FOUND', 'advisor-result');
    return c.json(toAdvisorResult(row), 202);
  });

  app.openapi(listRouteDef, async (c) => {
    const profileId = asProfileId(c.req.valid('param').profileId);
    const { limit, cursor, filter } = c.req.valid('query');
    const p = await scopeOf(c, di, profileId);
    // The query schema has already proven both halves and the separator, so the split cannot fail here.
    let cursorObj: { createdAt: string; id: string } | null = null;
    if (cursor !== undefined) {
      const { timestamp, id } = splitCompositeCursor(cursor, CURSOR_SEPARATOR);
      cursorObj = { createdAt: timestamp, id };
    }
    const [runs, total] = await Promise.all([
      p.backtestRuns.list({ limit, cursor: cursorObj, filter }),
      p.backtestRuns.count({ filter }),
    ]);
    const last = runs.at(-1);
    const nextCursor =
      runs.length === limit && last !== undefined
        ? `${last.cursorToken}${CURSOR_SEPARATOR}${last.id}`
        : null;
    return c.json(
      {
        items: runs.map((r) => {
          const params = r.params as BacktestParams;
          return {
            runId: r.id,
            status: r.status as BacktestStatus,
            progress: r.progress,
            symbols: r.symbols,
            createdAt: r.createdAt.toISOString(),
            finishedAt: r.finishedAt?.toISOString() ?? null,
            fromMs: params.fromMs,
            toMs: params.toMs,
            totalReturnPct: (r.result as BacktestResult | null)?.metrics.totalReturnPct ?? null,
          };
        }),
        nextCursor,
        total,
      },
      200,
    );
  });

  return app;
};
